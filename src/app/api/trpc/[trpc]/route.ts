import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/routers";
import { createTRPCContext } from "@/server/trpc";
import { errorLogLine } from "@/lib/security/errorLogLine";

/** Next.js App Router handler — connects HTTP requests to tRPC */
const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: createTRPCContext,
    // A 500 is the server's own failure, and the client sees only fixed text
    // for it. Leave one content-free trace: the procedure path and safe codes
    // (issue #171). tRPC wraps the thrown error, so describe its `cause`.
    // Guard, not-found and input errors are expected outcomes; skip them.
    onError: ({ error, path }) => {
      if (error.code !== "INTERNAL_SERVER_ERROR") return;
      const line = errorLogLine("[trpc] procedure failed", { path }, error.cause ?? error);
      process.stderr.write(`${line}\n`);
    },
  });

export { handler as GET, handler as POST };
