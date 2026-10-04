import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server"
import { NextResponse } from "next/server"

const isSignIn = createRouteMatcher(["/sign-in(.*)"])

export default clerkMiddleware(async (auth, request) => {
  if (isSignIn(request) || request.nextUrl.pathname.startsWith("/api/v1/")) return
  if (!process.env.PLAN_MANAGER_OWNER_CLERK_USER_ID || !process.env.CLERK_SECRET_KEY || !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) return new NextResponse("Hosted service is unavailable", { status: 503 })
  const authState = await auth()
  if (!authState.userId) return authState.redirectToSignIn()
  if (authState.userId !== process.env.PLAN_MANAGER_OWNER_CLERK_USER_ID) return new NextResponse("Forbidden", { status: 403 })
})

export const config = { matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)"] }
