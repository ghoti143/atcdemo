import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { WasmSpike } from "@/components/wasm-spike";

export default function Page() {
	return (
		<main className="h-screen flex items-center justify-center p-4">
			<Card className="w-full max-w-md border-2">
				<CardHeader>
					<CardTitle className="text-center text-2xl font-bold">
						ATC Demo
					</CardTitle>
					<CardDescription className="text-center">
						Boston / New York / Philadelphia / DC corridor
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-2 text-center text-sm text-muted-foreground">
					<p>Scaffold only. The map arrives in milestone 3.</p>
					<WasmSpike />
				</CardContent>
			</Card>
		</main>
	);
}
