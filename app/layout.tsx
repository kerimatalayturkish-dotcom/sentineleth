import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Press_Start_2P } from "next/font/google";
import { Providers } from "./providers";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { MusicPlayer } from "@/components/MusicPlayer";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const pixelFont = Press_Start_2P({
  variable: "--font-pixel",
  weight: "400",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SentinelETH",
  description: "First Agentic NFT Collection on Ethereum — mint with your AI agent.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${pixelFont.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <Providers>
          <Header />
          <div className="flex-1">{children}</div>
          <Footer />
          <MusicPlayer />
        </Providers>
      </body>
    </html>
  );
}
