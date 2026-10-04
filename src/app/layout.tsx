import type { Metadata } from "next"
import { ClerkProvider } from "@clerk/nextjs"
import "./globals.css"

export const metadata: Metadata = {
  title: "Plan Manager",
  description: "Private plan library",
  icons: { icon: "/dashboard-icon.png" },
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <ClerkProvider><html lang="en" data-dashboard-environment="hosted"><body>{children}</body></html></ClerkProvider>
}
