import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ともしび めいろ",
  description: "エサが光る迷路。食べるほど暗くなり、おばけは暗がりを追ってくる(光はRadiance Cascades)。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className="h-full">
      <body className="h-full">{children}</body>
    </html>
  );
}
