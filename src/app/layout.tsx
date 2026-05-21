import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { Providers } from "./providers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Nalu",
  description: "AI-powered learning platform — Duolingo for anything",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-kanagawa-atmos">
        {/* Cap the interface to a centered reading-width column. The
            atmospheric gradient lives on <body> so it fills the whole
            viewport, including the margins on either side of the column. */}
        <div className="mx-auto w-full max-w-2xl">
          <Providers>{children}</Providers>
        </div>
        <Toaster
          position="top-center"
          toastOptions={{ className: "font-sans text-[13px]" }}
          closeButton={false}
          richColors
        />
      </body>
    </html>
  );
}
