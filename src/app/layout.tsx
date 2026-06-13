import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import BottomNav from "@/components/BottomNav";
import { ToastProvider } from "@/components/Toast";
import { TxDrawerProvider } from "@/components/TransactionDrawer";
import { SyncOnLaunch } from "@/components/SyncOnLaunch";

// Apply the saved theme before paint to avoid a flash of the wrong theme.
const themeScript = `try{var t=localStorage.getItem('theme')||'light';document.documentElement.dataset.theme=t;}catch(e){}`;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Copilot Lite",
  description: "A simplified personal finance dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full">
        <ToastProvider>
          <SyncOnLaunch />
          <TxDrawerProvider>
            {/* Fixed-height shell: the sidebar stays put and `main` is the only
                scroll area, so the sidebar nav and each page header can stick. */}
            <div className="flex h-screen overflow-hidden">
              <Sidebar />
              {/* Bottom padding (mobile only) so content clears the fixed
                  BottomNav + the iPhone home-indicator safe area. */}
              <main className="flex-1 overflow-y-auto overflow-x-hidden pb-[calc(4.5rem+env(safe-area-inset-bottom))] sm:pb-0">
                {children}
              </main>
            </div>
            {/* Mobile tab bar (fixed; hidden at sm+). Outside the overflow-hidden
                row so its fixed position isn't affected. */}
            <BottomNav />
          </TxDrawerProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
