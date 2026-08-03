import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";
import { ServiceWorkerRegistration } from "@/components/os/service-worker";

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
    // iOS манифест не читает: иконку домашнего экрана он берёт отсюда.
    startupImage: [],
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
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
      <body className="bg-bg font-sans text-fg antialiased">
        {children}
        <ServiceWorkerRegistration version={process.env.BUILD_SHA?.slice(0, 7) ?? "dev"} />
      </body>
    </html>
  );
}
