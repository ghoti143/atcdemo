import { handleAuthRequest } from "@/lib/auth";

export const GET = (request: Request) => handleAuthRequest(request);
export const POST = (request: Request) => handleAuthRequest(request);
