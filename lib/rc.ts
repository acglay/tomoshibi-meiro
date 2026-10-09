// Radiance Cascades 2D renderer (WebGL2)
// scene(emission+solid) -> JFA distance field -> cascades (top->0, raymarch+merge) -> fluence -> composite

export const PROBE_N = 512; // light probes read back per frame (one per open maze tile)
export const FLOATS = 12; // per sprite instance: x0,y0,x1,y1, r,shape,soft,extra, R,G,B,A

export class Batch {
  data = new Float32Array(FLOATS * 1024);
  n = 0;
  reset() {
    this.n = 0;
  }
  push(x0: number, y0: number, x1: number, y1: number, r: number, shape: number, soft: number, extra: number, R: number, G: number, B: number, A: number) {
    if ((this.n + 1) * FLOATS > this.data.length) {
      const d = new Float32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    const o = this.n * FLOATS;
    const d = this.data;
    d[o] = x0; d[o + 1] = y0; d[o + 2] = x1; d[o + 3] = y1;
    d[o + 4] = r; d[o + 5] = shape; d[o + 6] = soft; d[o + 7] = extra;
    d[o + 8] = R; d[o + 9] = G; d[o + 10] = B; d[o + 11] = A;
    this.n++;
  }
  circle(x: number, y: number, r: number, R: number, G: number, B: number, A = 1, soft = 0, extra = 0) {
    this.push(x, y, x, y, r, 0, soft, extra, R, G, B, A);
  }
  line(x0: number, y0: number, x1: number, y1: number, r: number, R: number, G: number, B: number, A = 1, soft = 0, extra = 0) {
    this.push(x0, y0, x1, y1, r, 0, soft, extra, R, G, B, A);
  }
}

export type Frame = {
  camX: number; // world at canvas left
  camY: number; // world at canvas top
  wpp: number; // world px per canvas px
  map: Uint8Array;
  mapW: number;
  mapH: number;
  tile: number;
  mapVersion: number;
  scene: Batch; // light emitters + occluders (into RC)
  lit: Batch; // drawn on canvas, lit by RC
  glow: Batch; // additive glows on canvas
  probes: Float32Array; // world xy pairs to read light at
  probeCount: number;
  view: number; // 0 final, 1 light only, 2 distance field
  time: number;
  exposure: number;
  ambient: number;
  bounce: number;
  fog: number; // absorption per world px (display)
  gameFog: number; // what enemies see
  gameBounce: number;
  toe: number; // crushes dark tones
  shake: number;
  side?: boolean; // side view: open tiles are the cave's back wall, walls have no top-down brick face
};

const VS_FULL = `#version 300 es
void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); gl_Position = vec4(p*2.0-1.0,0.0,1.0); }`;

const VS_SPRITE = `#version 300 es
layout(location=0) in vec2 a_c;
layout(location=1) in vec4 i_a;
layout(location=2) in vec4 i_b;
layout(location=3) in vec4 i_c;
uniform vec2 u_origin; uniform float u_scale; uniform vec2 u_size; uniform float u_flip; uniform float u_minR; uniform int u_mode;
out vec2 v_w; flat out vec4 v_a; flat out vec4 v_b; flat out vec4 v_c;
void main(){
  vec4 a=i_a; vec4 b=i_b; vec4 c=i_c;
  if(b.y<0.5){
    float r0=b.x; b.x=max(b.x,u_minR/u_scale);
    // a light enlarged to stay visible to the cascades keeps its far-field output (emission x radius)
    if(u_mode==0 && b.x>r0) c.rgb*=r0/b.x;
  }
  vec2 lo, hi;
  if(b.y<0.5){ lo=min(a.xy,a.zw)-b.x; hi=max(a.xy,a.zw)+b.x; }
  else { lo=a.xy-a.zw-b.x; hi=a.xy+a.zw+b.x; }
  float pad = 2.0/u_scale + (u_mode==2 ? b.z*3.0 : 0.0);
  lo-=pad; hi+=pad;
  vec2 w = mix(lo,hi,a_c*0.5+0.5);
  vec2 t = (w-u_origin)*u_scale/u_size*2.0-1.0;
  t.y*=u_flip;
  gl_Position=vec4(t,0.0,1.0);
  v_w=w; v_a=a; v_b=b; v_c=c;
}`;

const TONE = `
uniform float u_toe;
vec3 tone(vec3 c){ c = c*c/(c+u_toe); c = 1.0-exp(-c); return pow(c, vec3(1.0/2.2)); }`;

const FS_SPRITE = `#version 300 es
precision highp float; precision highp int;
in vec2 v_w; flat in vec4 v_a; flat in vec4 v_b; flat in vec4 v_c;
uniform int u_mode; uniform float u_scale;
uniform sampler2D u_flu; uniform vec2 u_rcOrigin; uniform float u_rcScale; uniform vec2 u_rcSize;
uniform float u_exposure; uniform float u_ambient;
out vec4 o;
${TONE}
float sdf(vec2 p){
  if(v_b.y<0.5){ vec2 pa=p-v_a.xy, ba=v_a.zw-v_a.xy; float h=clamp(dot(pa,ba)/max(dot(ba,ba),1e-6),0.0,1.0); return length(pa-ba*h)-v_b.x; }
  vec2 q=abs(p-v_a.xy)-v_a.zw; return length(max(q,0.0))+min(max(q.x,q.y),0.0)-v_b.x;
}
void main(){
  float d=sdf(v_w);
  if(u_mode==0){ if(d>0.0) discard; o=v_c; return; }
  if(u_mode==1){
    float aa = 1.0/u_scale;
    float cov = clamp(0.5-d/aa,0.0,1.0);
    if(cov<=0.0) discard;
    vec3 L = texture(u_flu,(v_w-u_rcOrigin)*u_rcScale/u_rcSize).rgb;
    vec3 c = v_c.rgb*(L*u_exposure+u_ambient) + v_c.rgb*v_b.w;
    // rim: brighter toward the edge facing nothing in particular, gives volume
    c *= 0.75+0.5*clamp(-d/max(v_b.x,1.0),0.0,1.0);
    o=vec4(tone(c), v_c.a*cov);
    return;
  }
  float soft=max(v_b.z,0.001);
  float g = d<0.0 ? 1.0 : exp(-d/soft*2.5);
  g*=g;
  if(g<0.002) discard;
  o=vec4(v_c.rgb*g*v_c.a, 0.0);
}`;

const FS_WALLS = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D u_map; uniform vec2 u_mapSize; uniform float u_tile;
uniform vec2 u_rcOrigin; uniform float u_rcScale;
uniform sampler2D u_prev; uniform vec2 u_prevOrigin; uniform vec2 u_prevSize; uniform float u_bounce; uniform float u_hasPrev;
out vec4 o;
float isWall(vec2 w){ vec2 t=floor(w/u_tile); if(t.x<0.0||t.y<0.0||t.x>=u_mapSize.x||t.y>=u_mapSize.y) return 1.0; return texelFetch(u_map, ivec2(t),0).r>0.5?1.0:0.0; }
vec3 prevL(vec2 w){ vec2 uv=(w-u_prevOrigin)*u_rcScale/u_prevSize; if(any(lessThan(uv,vec2(0.0)))||any(greaterThan(uv,vec2(1.0)))) return vec3(0.0); return texture(u_prev,uv).rgb; }
void main(){
  vec2 w = u_rcOrigin + gl_FragCoord.xy/u_rcScale;
  if(isWall(w)<0.5){ o=vec4(0.0); return; }
  vec3 e=vec3(0.0);
  if(u_hasPrev>0.5){
    // pick up light only from floor next to the wall (sampling inside walls would feed the wall its own light back = runaway)
    float r = 3.0/u_rcScale;
    for(int k=0;k<4;k++){
      vec2 o2 = k==0?vec2(r,0.0):k==1?vec2(-r,0.0):k==2?vec2(0.0,r):vec2(0.0,-r);
      vec2 q=w+o2;
      if(isWall(q)<0.5) e=max(e,prevL(q));
    }
  }
  o=vec4(e*u_bounce*vec3(0.62,0.5,0.42),1.0);
}`;

const FS_SEED = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D u_scene;
out vec4 o;
void main(){ ivec2 p=ivec2(gl_FragCoord.xy); float s=texelFetch(u_scene,p,0).a; o = s>0.5 ? vec4(gl_FragCoord.xy,0.0,1.0) : vec4(-1.0); }`;

const FS_JFA = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D u_src; uniform int u_step; uniform ivec2 u_size;
out vec4 o;
void main(){
  vec2 p=gl_FragCoord.xy; ivec2 ip=ivec2(p);
  vec4 best=vec4(-1.0); float bd=1e9;
  for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){
    ivec2 q=ip+ivec2(x,y)*u_step;
    if(q.x<0||q.y<0||q.x>=u_size.x||q.y>=u_size.y) continue;
    vec4 s=texelFetch(u_src,q,0);
    if(s.x<0.0) continue;
    float d=distance(s.xy,p);
    if(d<bd){bd=d;best=s;}
  }
  o=best;
}`;

const FS_DIST = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D u_src;
out vec4 o;
void main(){ vec4 s=texelFetch(u_src,ivec2(gl_FragCoord.xy),0); float d = s.x<0.0 ? 1e4 : distance(s.xy,gl_FragCoord.xy); o=vec4(d,0.0,0.0,1.0); }`;

const FS_CASCADE = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D u_scene; uniform sampler2D u_dist; uniform sampler2D u_upper; uniform sampler2D u_seed;
uniform vec2 u_size; uniform int u_spacing; uniform int u_side; uniform vec2 u_interval; uniform int u_hasUpper; uniform float u_fog; uniform int u_fix;
out vec4 o;
const float TAU=6.28318530718;
vec4 march(vec2 s, vec2 e){
  vec2 dv=e-s; float len=length(dv); vec2 dir=dv/max(len,1e-4);
  float tt=0.0;
  for(int i=0;i<40;i++){
    vec2 p=s+dir*tt;
    if(p.x<0.0||p.y<0.0||p.x>=u_size.x||p.y>=u_size.y) break;
    vec2 uv=p/u_size;
    float d=texture(u_dist,uv).r;
    if(d<0.75){ vec2 sd=texelFetch(u_seed,ivec2(p),0).xy; return vec4(texelFetch(u_scene,ivec2(sd),0).rgb*exp(-u_fog*tt),0.0); }
    tt+=max(d-0.25,0.5);
    if(tt>=len) break;
  }
  return vec4(0.0,0.0,0.0,exp(-u_fog*len));
}
void main(){
  ivec2 t=ivec2(gl_FragCoord.xy);
  ivec2 P=ivec2(u_size)/u_spacing;
  ivec2 block=t/P; ivec2 probe=t-block*P;
  int idx=block.y*u_side+block.x; int rays=u_side*u_side;
  float ang=(float(idx)+0.5)/float(rays)*TAU;
  vec2 dir=vec2(cos(ang),sin(ang));
  vec2 org=(vec2(probe)+0.5)*float(u_spacing);
  if(u_hasUpper==0){ vec4 r=march(org+dir*u_interval.x, org+dir*u_interval.y); o=vec4(r.rgb,r.a); return; }
  if(u_fix==0){
    // cheap merge: one ray, upper probes interpolated by the texture unit
    vec4 r=march(org+dir*u_interval.x, org+dir*u_interval.y);
    if(r.a<=0.0){ o=vec4(r.rgb,1.0); return; }
    int sideU0=u_side*2; ivec2 PU0=P/2;
    vec2 c=clamp((vec2(probe)+0.5)*0.5, vec2(0.5), vec2(PU0)-0.5);
    vec3 up=vec3(0.0);
    for(int k=0;k<4;k++){ int ui=idx*4+k; ivec2 ub=ivec2(ui-(ui/sideU0)*sideU0, ui/sideU0); up+=texture(u_upper,(vec2(ub*PU0)+c)/u_size).rgb; }
    o=vec4(r.rgb+r.a*up*0.25,1.0); return;
  }
  // bilinear fix: aim this ray at each of the 4 upper probes' interval start, then merge that probe's radiance
  int sideU=u_side*2; ivec2 PU=P/2;
  vec2 pu=(vec2(probe)+0.5)*0.5-0.5;
  vec2 b0=floor(pu); vec2 f=pu-b0;
  ivec2 ub[4];
  for(int k=0;k<4;k++){ int ui=idx*4+k; ub[k]=ivec2(ui-(ui/sideU)*sideU, ui/sideU); }
  vec3 acc=vec3(0.0);
  for(int j=0;j<4;j++){
    ivec2 dq=ivec2(j&1, j>>1);
    ivec2 q=clamp(ivec2(b0)+dq, ivec2(0), PU-1);
    float w=(dq.x==1?f.x:1.0-f.x)*(dq.y==1?f.y:1.0-f.y);
    if(w<=0.0) continue;
    vec2 Q=(vec2(q)+0.5)*float(u_spacing*2);
    vec4 r=march(org+dir*u_interval.x, Q+dir*u_interval.y);
    vec3 up=vec3(0.0);
    if(r.a>0.0){ for(int k=0;k<4;k++) up+=texelFetch(u_upper, ub[k]*PU+q, 0).rgb; up*=0.25; }
    acc+=w*(r.rgb+r.a*up);
  }
  o=vec4(acc,1.0);
}`;

const FS_FLUENCE = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D u_c0; uniform vec2 u_size;
out vec4 o;
void main(){
  ivec2 p=ivec2(gl_FragCoord.xy); ivec2 P=ivec2(u_size)/2;
  vec3 s=texelFetch(u_c0,p,0).rgb+texelFetch(u_c0,p+ivec2(P.x,0),0).rgb+texelFetch(u_c0,p+ivec2(0,P.y),0).rgb+texelFetch(u_c0,p+P,0).rgb;
  o=vec4(s*0.25,1.0);
}`;

const FS_COMPOSITE = `#version 300 es
precision highp float; precision highp int;
uniform vec2 u_cam; uniform float u_wpp; uniform float u_canvasH;
uniform sampler2D u_map; uniform vec2 u_mapSize; uniform float u_tile;
uniform sampler2D u_flu; uniform sampler2D u_dist; uniform vec2 u_rcOrigin; uniform float u_rcScale; uniform vec2 u_rcSize;
uniform float u_exposure; uniform float u_ambient; uniform int u_view; uniform int u_side;
out vec4 o;
${TONE}
float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float isWall(vec2 t){ if(t.x<0.0||t.y<0.0||t.x>=u_mapSize.x||t.y>=u_mapSize.y) return 1.0; return texelFetch(u_map, ivec2(t),0).r>0.5?1.0:0.0; }
vec3 L(vec2 w){ return texture(u_flu,(w-u_rcOrigin)*u_rcScale/u_rcSize).rgb; }
void main(){
  vec2 w = u_cam + vec2(gl_FragCoord.x, u_canvasH-gl_FragCoord.y)*u_wpp;
  if(u_view==2){
    float d=texture(u_dist,(w-u_rcOrigin)*u_rcScale/u_rcSize).r;
    float band=0.5+0.5*cos(d*0.8);
    vec3 c = d<0.75 ? vec3(1.0,0.85,0.4) : mix(vec3(0.05,0.08,0.2),vec3(0.2,0.5,0.9),band)*exp(-d*0.01);
    o=vec4(c,1.0); return;
  }
  vec2 t=floor(w/u_tile); vec2 f=fract(w/u_tile);
  float wall=isWall(t);
  vec3 c;
  if(u_view==1){
    c=L(w)*u_exposure; if(wall>0.5) c*=0.25; o=vec4(tone(c),1.0); return;
  }
  if(wall<0.5 && u_side==1){
    // back wall of the cave: big rough stones, darker than a floor
    vec2 q=w/(u_tile*vec2(1.5,1.0)); q.x+=mod(floor(q.y),2.0)*0.5;
    vec2 sf=fract(q); float h=hash(floor(q));
    float g=min(min(sf.x,1.0-sf.x),min(sf.y,1.0-sf.y));
    vec3 alb=mix(vec3(0.06,0.065,0.085),vec3(0.11,0.11,0.13),h)*(0.85+0.3*hash(floor(w/4.0)))*mix(0.4,1.0,smoothstep(0.02,0.08,g));
    c=alb*(L(w)*u_exposure+u_ambient);
  } else if(wall<0.5){
    vec2 sl=floor(w/(u_tile*0.5)+vec2(mod(floor(w.y/(u_tile*0.5)),2.0)*0.5,0.0));
    vec2 sf=fract(w/(u_tile*0.5)+vec2(mod(floor(w.y/(u_tile*0.5)),2.0)*0.5,0.0));
    float h=hash(sl);
    float g=min(min(sf.x,1.0-sf.x),min(sf.y,1.0-sf.y));
    float grout=smoothstep(0.02,0.07,g);
    vec3 alb=mix(vec3(0.33,0.30,0.27),vec3(0.46,0.42,0.36),h)*(0.9+0.2*hash(floor(w/3.0)));
    alb*=mix(0.35,1.0,grout);
    c=alb*(L(w)*u_exposure+u_ambient);
  } else {
    float below=isWall(t+vec2(0.0,1.0));
    if(u_side==0 && below<0.5 && f.y>0.5){
      float fy=(f.y-0.5)*2.0;
      vec2 wb=vec2(w.x,(t.y+1.0)*u_tile+u_tile*0.18);
      float brick=step(0.08,fract(fy*3.0))*step(0.04,fract(f.x*2.0+floor(fy*3.0)*0.5));
      vec3 alb=vec3(0.30,0.25,0.21)*mix(0.45,1.0,brick)*(0.55+0.45*fy);
      c=alb*(L(wb)*u_exposure+u_ambient);
    } else {
      float r=u_tile*0.35;
      vec3 m=L(w);
      m=max(m,L(w+vec2(r,0.0))*0.8); m=max(m,L(w-vec2(r,0.0))*0.8);
      m=max(m,L(w+vec2(0.0,r))*0.8); m=max(m,L(w-vec2(0.0,r))*0.8);
      float h=hash(t);
      vec3 alb=vec3(0.12,0.11,0.11)*(0.8+0.4*h);
      c=alb*(m*u_exposure*0.6+u_ambient);
    }
  }
  o=vec4(tone(c),1.0);
}`;

const FS_PROBE = `#version 300 es
precision highp float; precision highp int;
uniform sampler2D u_pos; uniform sampler2D u_flu; uniform vec2 u_rcOrigin; uniform float u_rcScale; uniform vec2 u_rcSize;
out vec4 o;
void main(){
  vec2 w=texelFetch(u_pos,ivec2(gl_FragCoord.x,0),0).xy;
  vec3 L=texture(u_flu,(w-u_rcOrigin)*u_rcScale/u_rcSize).rgb;
  float lum=dot(L,vec3(0.3,0.55,0.15));
  o=vec4(lum,0.0,0.0,1.0);
}`;

type Tex = { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number };

export class RC {
  gl: WebGL2RenderingContext;
  ok = true;
  err = "";
  rcScale = 0.5;
  baseInterval = 2;
  cascades = 0;
  W = 0;
  H = 0;
  originX = 0;
  originY = 0;
  private progs: Record<string, WebGLProgram> = {};
  private uni = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private vao: WebGLVertexArrayObject;
  private inst: WebGLBuffer;
  private scene?: Tex;
  private jfa: Tex[] = [];
  private dist?: Tex;
  private cas: Tex[] = [];
  private flus: Tex[] = [];
  private hasPrev = [false, false];
  private prevO: [number, number][] = [[0, 0], [0, 0]];
  split = false;
  private mapTex: WebGLTexture;
  mapVersion = -1;
  private posTex: WebGLTexture;
  private probeOut: Tex;
  private pbo: WebGLBuffer;
  private fence: WebGLSync | null = null;
  private pending = 0;
  private lumBuf = new Float32Array(PROBE_N * 4);
  lum = new Float32Array(PROBE_N);
  lumReady = 0; // count valid in lum (from a previous frame)
  lumSerial = 0;
  private pendingSerial = 0;
  serial = 0;
  private tq: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private query: WebGLQuery | null = null;
  private queryOpen = false;
  hasTimer = false;
  bilinearFix = true;
  finishEachFrame = false; // mobile GPUs (Adreno) queue frames without limit; finish() keeps latency/frame rate sane
  gpuMs = -1; // last measured GPU time of one frame (-1 = no timer on this device)
  gpuSerial = 0;
  renderer = "";

  constructor(canvas: HTMLCanvasElement, preserve = true) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: preserve });
    if (!gl) throw new Error("WebGL2が使えません");
    this.gl = gl;
    this.tq = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    this.hasTimer = !!this.tq;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    this.renderer = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    if (!gl.getExtension("EXT_color_buffer_float")) {
      this.ok = false;
      this.err = "この端末は浮動小数テクスチャへの描画(EXT_color_buffer_float)に未対応です";
    }
    const mk = (name: string, vs: string, fs: string) => {
      const p = gl.createProgram()!;
      for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
        const s = gl.createShader(type)!;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(name + ": " + gl.getShaderInfoLog(s));
        gl.attachShader(p, s);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(name + ": " + gl.getProgramInfoLog(p));
      this.progs[name] = p;
      this.uni.set(p, new Map());
    };
    mk("sprite", VS_SPRITE, FS_SPRITE);
    mk("walls", VS_FULL, FS_WALLS);
    mk("seed", VS_FULL, FS_SEED);
    mk("jfa", VS_FULL, FS_JFA);
    mk("dist", VS_FULL, FS_DIST);
    mk("cascade", VS_FULL, FS_CASCADE);
    mk("fluence", VS_FULL, FS_FLUENCE);
    mk("composite", VS_FULL, FS_COMPOSITE);
    mk("probe", VS_FULL, FS_PROBE);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.inst = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    for (let i = 0; i < 3; i++) {
      gl.enableVertexAttribArray(1 + i);
      gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, FLOATS * 4, i * 16);
      gl.vertexAttribDivisor(1 + i, 1);
    }
    gl.bindVertexArray(null);

    this.mapTex = gl.createTexture()!;
    this.posTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.posTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, PROBE_N, 1, 0, gl.RG, gl.FLOAT, null);
    this.nearest();
    this.probeOut = this.makeTex(PROBE_N, 1, gl.RGBA32F, gl.RGBA, gl.FLOAT, false);
    this.pbo = gl.createBuffer()!;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, PROBE_N * 16, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
  }

  private nearest() {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private makeTex(w: number, h: number, ifmt: number, fmt: number, type: number, linear: boolean): Tex {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, null);
    this.nearest();
    if (linear) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h };
  }

  private freeTex(t?: Tex) {
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fb);
  }

  private resize(W: number, H: number) {
    if (W === this.W && H === this.H) return;
    const gl = this.gl;
    [this.scene, this.dist, ...this.flus, ...this.jfa, ...this.cas].forEach((t) => this.freeTex(t));
    this.W = W;
    this.H = H;
    this.scene = this.makeTex(W, H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, false);
    this.jfa = [0, 1].map(() => this.makeTex(W, H, gl.RG32F, gl.RG, gl.FLOAT, false));
    this.dist = this.makeTex(W, H, gl.R16F, gl.RED, gl.HALF_FLOAT, true);
    this.cas = [0, 1].map(() => this.makeTex(W, H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, true));
    this.flus = [0, 1].map(() => this.makeTex(W / 2, H / 2, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, true));
    this.hasPrev = [false, false];
  }

  private u(p: WebGLProgram, name: string) {
    const m = this.uni.get(p)!;
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(p, name));
    return m.get(name)!;
  }

  private use(name: string, target: Tex | null, w: number, h: number) {
    const gl = this.gl;
    const p = this.progs[name];
    gl.useProgram(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, w, h);
    return p;
  }

  private bindTex(p: WebGLProgram, name: string, unit: number, tex: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.u(p, name), unit);
  }

  private full() {
    this.gl.bindVertexArray(null);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  private sprites(b: Batch, mode: number, origin: [number, number], scale: number, size: [number, number], flip: number, minR: number) {
    if (b.n === 0) return;
    const gl = this.gl;
    const p = this.progs.sprite;
    gl.uniform2f(this.u(p, "u_origin"), origin[0], origin[1]);
    gl.uniform1f(this.u(p, "u_scale"), scale);
    gl.uniform2f(this.u(p, "u_size"), size[0], size[1]);
    gl.uniform1f(this.u(p, "u_flip"), flip);
    gl.uniform1f(this.u(p, "u_minR"), minR);
    gl.uniform1i(this.u(p, "u_mode"), mode);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.bufferData(gl.ARRAY_BUFFER, b.data.subarray(0, b.n * FLOATS), gl.STREAM_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.n);
    gl.bindVertexArray(null);
  }

  render(f: Frame) {
    const gl = this.gl;
    const tq = this.tq;
    if (tq && this.query && !this.queryOpen) {
      if (gl.getQueryParameter(this.query, gl.QUERY_RESULT_AVAILABLE)) {
        if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) {
          this.gpuMs = gl.getQueryParameter(this.query, gl.QUERY_RESULT) / 1e6;
          this.gpuSerial++;
        }
        gl.deleteQuery(this.query);
        this.query = null;
      }
    }
    if (tq && !this.query) {
      this.query = gl.createQuery();
      gl.beginQuery(tq.TIME_ELAPSED_EXT, this.query!);
      this.queryOpen = true;
    }
    this.renderInner(f);
    if (this.queryOpen) {
      gl.endQuery(tq!.TIME_ELAPSED_EXT);
      this.queryOpen = false;
    }
    // after the timer: the fence wait/readback splits the command stream, and the GPU timer would count
    // the idle gap until the next flush (~1 frame) as work
    this.probeReadback(f);
    if (this.finishEachFrame) gl.finish();
  }

  private renderInner(f: Frame) {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    const cw = canvas.width;
    const ch = canvas.height;
    const s = this.rcScale;

    // cascade count from the RC region's diagonal
    const viewW = cw * f.wpp;
    const viewH = ch * f.wpp;
    let nc = 1;
    const diagGuess = Math.hypot(viewW, viewH) * s + 256;
    while ((this.baseInterval * (Math.pow(4, nc) - 1)) / 3 < diagGuess && nc < 8) nc++;
    const top = Math.pow(2, nc);
    const cell = top / s; // world size of one top-probe cell; snapping to it keeps every probe fixed in the world
    const wc = Math.ceil(viewW / cell) + 3;
    const hc = Math.ceil(viewH / cell) + 3;
    this.resize(wc * top, hc * top);
    this.cascades = nc;
    const W = this.W;
    const H = this.H;
    const ox = (Math.floor(f.camX / cell) - 1) * cell;
    const oy = (Math.floor(f.camY / cell) - 1) * cell;
    this.originX = ox;
    this.originY = oy;

    if (f.mapVersion !== this.mapVersion) {
      gl.bindTexture(gl.TEXTURE_2D, this.mapTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, f.mapW, f.mapH, 0, gl.RED, gl.UNSIGNED_BYTE, f.map.map((v) => (v === 1 ? 255 : 0)));
      this.nearest();
      this.mapVersion = f.mapVersion;
    }

    gl.disable(gl.BLEND);
    // enemies read light solved with the game's own fog/bounce; debug display values only change the picture
    this.split = f.gameFog !== f.fog || f.gameBounce !== f.bounce;
    if (this.split) this.solve(f, f.gameFog, f.gameBounce, 1, W, H, ox, oy, nc);
    this.solve(f, f.fog, f.bounce, 0, W, H, ox, oy, nc);
    let p: WebGLProgram;

    // 7) composite to canvas
    p = this.use("composite", null, cw, ch);
    gl.uniform2f(this.u(p, "u_cam"), f.camX, f.camY);
    gl.uniform1f(this.u(p, "u_wpp"), f.wpp);
    gl.uniform1f(this.u(p, "u_canvasH"), ch);
    this.bindTex(p, "u_map", 0, this.mapTex);
    gl.uniform2f(this.u(p, "u_mapSize"), f.mapW, f.mapH);
    gl.uniform1f(this.u(p, "u_tile"), f.tile);
    this.bindTex(p, "u_flu", 1, this.flus[0].tex);
    this.bindTex(p, "u_dist", 2, this.dist!.tex);
    gl.uniform2f(this.u(p, "u_rcOrigin"), ox, oy);
    gl.uniform1f(this.u(p, "u_rcScale"), s);
    gl.uniform2f(this.u(p, "u_rcSize"), W, H);
    gl.uniform1f(this.u(p, "u_exposure"), f.exposure);
    gl.uniform1f(this.u(p, "u_ambient"), f.ambient);
    gl.uniform1i(this.u(p, "u_view"), f.view);
    gl.uniform1i(this.u(p, "u_side"), f.side ? 1 : 0);
    gl.uniform1f(this.u(p, "u_toe"), f.toe);
    this.full();
    if (f.view === 2) return;

    p = this.use("sprite", null, cw, ch);
    this.bindTex(p, "u_flu", 0, this.flus[0].tex);
    gl.uniform2f(this.u(p, "u_rcOrigin"), ox, oy);
    gl.uniform1f(this.u(p, "u_rcScale"), s);
    gl.uniform2f(this.u(p, "u_rcSize"), W, H);
    gl.uniform1f(this.u(p, "u_exposure"), f.exposure);
    gl.uniform1f(this.u(p, "u_ambient"), f.ambient);
    gl.uniform1f(this.u(p, "u_toe"), f.toe);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (f.view === 0) this.sprites(f.lit, 1, [f.camX, f.camY], 1 / f.wpp, [cw, ch], -1, 0);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.sprites(f.glow, 2, [f.camX, f.camY], 1 / f.wpp, [cw, ch], -1, 0);
    gl.disable(gl.BLEND);
  }

  // light probes for gameplay (async readback)
  private probeReadback(f: Frame) {
    const gl = this.gl;
    const s = this.rcScale;
    const W = this.W;
    const H = this.H;
    const ox = this.originX;
    const oy = this.originY;
    const gameFlu = this.flus[this.split ? 1 : 0];
    this.collectProbe();
    if (f.probeCount > 0 && !this.fence) {
      gl.bindTexture(gl.TEXTURE_2D, this.posTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, Math.min(PROBE_N, f.probeCount), 1, gl.RG, gl.FLOAT, f.probes.subarray(0, Math.min(PROBE_N, f.probeCount) * 2));
      const p = this.use("probe", this.probeOut, PROBE_N, 1);
      this.bindTex(p, "u_pos", 0, this.posTex);
      this.bindTex(p, "u_flu", 1, gameFlu.tex);
      gl.uniform2f(this.u(p, "u_rcOrigin"), ox, oy);
      gl.uniform1f(this.u(p, "u_rcScale"), s);
      gl.uniform2f(this.u(p, "u_rcSize"), W, H);
      this.full();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.readPixels(0, 0, PROBE_N, 1, gl.RGBA, gl.FLOAT, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      this.pending = Math.min(PROBE_N, f.probeCount);
      this.pendingSerial = this.serial;
    }
  }

  private solve(f: Frame, fog: number, bounce: number, slot: number, W: number, H: number, ox: number, oy: number, nc: number) {
    const gl = this.gl;
    const s = this.rcScale;
    // 1) walls (+ bounce light from last frame)
    let p = this.use("walls", this.scene!, W, H);
    this.bindTex(p, "u_map", 0, this.mapTex);
    gl.uniform2f(this.u(p, "u_mapSize"), f.mapW, f.mapH);
    gl.uniform1f(this.u(p, "u_tile"), f.tile);
    gl.uniform2f(this.u(p, "u_rcOrigin"), ox, oy);
    gl.uniform1f(this.u(p, "u_rcScale"), s);
    this.bindTex(p, "u_prev", 1, this.flus[slot].tex);
    gl.uniform2f(this.u(p, "u_prevOrigin"), this.prevO[slot][0], this.prevO[slot][1]);
    gl.uniform2f(this.u(p, "u_prevSize"), W, H);
    gl.uniform1f(this.u(p, "u_bounce"), bounce);
    gl.uniform1f(this.u(p, "u_hasPrev"), this.hasPrev[slot] ? 1 : 0);
    this.full();
    // 2) emitters & occluders
    this.use("sprite", this.scene!, W, H);
    this.sprites(f.scene, 0, [ox, oy], s, [W, H], 1, 1.5);

    // 3) JFA distance field
    p = this.use("seed", this.jfa[0], W, H);
    this.bindTex(p, "u_scene", 0, this.scene!.tex);
    this.full();
    let src = 0;
    let step = Math.pow(2, Math.ceil(Math.log2(Math.max(W, H))) - 1);
    while (step >= 1) {
      p = this.use("jfa", this.jfa[1 - src], W, H);
      this.bindTex(p, "u_src", 0, this.jfa[src].tex);
      gl.uniform1i(this.u(p, "u_step"), step);
      gl.uniform2i(this.u(p, "u_size"), W, H);
      this.full();
      src = 1 - src;
      step = Math.floor(step / 2);
    }
    p = this.use("dist", this.dist!, W, H);
    this.bindTex(p, "u_src", 0, this.jfa[src].tex);
    this.full();

    // 4) cascades, top down
    let cur = 0;
    for (let n = nc - 1; n >= 0; n--) {
      const tgt = this.cas[cur];
      p = this.use("cascade", tgt, W, H);
      this.bindTex(p, "u_scene", 0, this.scene!.tex);
      this.bindTex(p, "u_dist", 1, this.dist!.tex);
      this.bindTex(p, "u_upper", 2, this.cas[1 - cur].tex);
      this.bindTex(p, "u_seed", 3, this.jfa[src].tex);
      gl.uniform2f(this.u(p, "u_size"), W, H);
      gl.uniform1i(this.u(p, "u_spacing"), Math.pow(2, n + 1));
      gl.uniform1i(this.u(p, "u_side"), Math.pow(2, n + 1));
      const a = (this.baseInterval * (Math.pow(4, n) - 1)) / 3;
      const b = (this.baseInterval * (Math.pow(4, n + 1) - 1)) / 3;
      gl.uniform2f(this.u(p, "u_interval"), a, b);
      gl.uniform1i(this.u(p, "u_hasUpper"), n === nc - 1 ? 0 : 1);
      gl.uniform1f(this.u(p, "u_fog"), fog / s);
      gl.uniform1i(this.u(p, "u_fix"), this.bilinearFix ? 1 : 0);
      this.full();
      cur = 1 - cur;
    }
    const c0 = this.cas[1 - cur];

    // 5) fluence (average of cascade0's 4 rays)
    p = this.use("fluence", this.flus[slot], W / 2, H / 2);
    this.bindTex(p, "u_c0", 0, c0.tex);
    gl.uniform2f(this.u(p, "u_size"), W, H);
    this.full();
    this.hasPrev[slot] = true;
    this.prevO[slot] = [ox, oy];

  }

  measureSync(pts: number[][], which: "view" | "game" = "view"): number[] {
    const gl = this.gl;
    const n = Math.min(PROBE_N, pts.length);
    const a = new Float32Array(n * 2);
    pts.slice(0, n).forEach((q, i) => { a[i * 2] = q[0]; a[i * 2 + 1] = q[1]; });
    gl.bindTexture(gl.TEXTURE_2D, this.posTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n, 1, gl.RG, gl.FLOAT, a);
    const p = this.use("probe", this.probeOut, PROBE_N, 1);
    this.bindTex(p, "u_pos", 0, this.posTex);
    this.bindTex(p, "u_flu", 1, this.flus[which === "game" && this.split ? 1 : 0].tex);
    gl.uniform2f(this.u(p, "u_rcOrigin"), this.originX, this.originY);
    gl.uniform1f(this.u(p, "u_rcScale"), this.rcScale);
    gl.uniform2f(this.u(p, "u_rcSize"), this.W, this.H);
    this.full();
    const buf = new Float32Array(PROBE_N * 4);
    gl.readPixels(0, 0, PROBE_N, 1, gl.RGBA, gl.FLOAT, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return Array.from({ length: n }, (_, i) => buf[i * 4]);
  }

  private collectProbe() {
    const gl = this.gl;
    if (!this.fence) return;
    const st = gl.clientWaitSync(this.fence, 0, 0);
    if (st !== gl.ALREADY_SIGNALED && st !== gl.CONDITION_SATISFIED) return;
    gl.deleteSync(this.fence);
    this.fence = null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.lumBuf);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    for (let i = 0; i < this.pending; i++) this.lum[i] = this.lumBuf[i * 4];
    this.lumReady = this.pending;
    this.lumSerial = this.pendingSerial;
  }
}
