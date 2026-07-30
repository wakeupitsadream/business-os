import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

// Кириллица подключена явно: без подсета "cyrillic" браузер подставил бы
// системный шрифт на весь русский текст, то есть практически на весь интерфейс.
const inter = Inter({
  subsets: ["latin", "cyrillic"],
  display: "swap",
  variable: "--font-inter",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin", "cyrillic"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "Business OS",
  description: "Пульт бизнес-жизни владельца: секретарь, финансы, продажи, разработка.",
  applicationName: "Business OS",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Business OS",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
  // Личный пульт одного владельца: в поиске ему делать нечего.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0A0A0B",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  // Нижняя навигация на телефоне уходит под «домашнюю полосу» без учёта
  // безопасной зоны — она считается по env(safe-area-inset-*), а тот работает
  // только при viewport-fit=cover.
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru" className={`${inter.variable} ${jetBrainsMono.variable}`}>
      <body className="bg-bg font-sans text-fg antialiased">{children}</body>
    </html>
  );
}
