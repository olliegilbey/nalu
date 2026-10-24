import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { SITE_URL } from "@/lib/config/site";
import { Providers } from "./providers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

/**
 * Site-wide metadata. Open Graph and Twitter fields inherit `title` and
 * `description` from here; Next fills them in. Relative URLs resolve against
 * `metadataBase`, so link unfurlers get absolute production URLs.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  // No page sets its own title yet. The template brands one when it does.
  title: { default: "Nalu: learn anything with an AI tutor", template: "%s | Nalu" },
  description:
    "Learn any topic through conversation with an AI tutor. Nalu scopes the topic, " +
    "places you with a short quiz, then teaches in short lessons called Waves, " +
    "with spaced repetition and XP.",
  // No `openGraph.url`: set here, every child page would claim the home URL.
  openGraph: {
    type: "website",
    siteName: "Nalu",
    // The brand emblem: square, so the Twitter card below is `summary`.
    images: [{ url: "/nalu-logo.png", width: 1024, height: 1024, alt: "Nalu wave emblem" }],
  },
  twitter: { card: "summary" },
};

/** App Router root layout: fonts, providers, centered column, global toaster. */
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
