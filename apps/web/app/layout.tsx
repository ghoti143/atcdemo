import type { Metadata } from "next";
import { Providers } from "@/components/providers";
import "./globals.css";

export const metadata: Metadata = {
	title: "ATC Demo",
	description: "A real-time air traffic picture",
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html lang="en" className="dark">
			<body>
				<Providers>{children}</Providers>
			</body>
		</html>
	);
}
