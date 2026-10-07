import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import SiteFooter from "@/components/site-footer";
import { PRODUCT_NAME } from "@/lib/site-branding";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: PRODUCT_NAME,
  description: "An educational financial literacy simulation game for students and classrooms.",
  openGraph: {
    title: PRODUCT_NAME,
    description: "An educational financial literacy simulation game for students and classrooms.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: PRODUCT_NAME,
    description: "An educational financial literacy simulation game for students and classrooms.",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
