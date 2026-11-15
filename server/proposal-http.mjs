import { boundedJson, HttpError } from "./account-http.mjs";
import { DocumentError } from "./document-store.mjs";
export const PROPOSAL_BODY_LIMIT = 1250000;
const createRoute =
  /^\/api\/workspaces\/([a-f0-9-]{36})\/documents\/([a-f0-9-]{36})\/proposals$/;
export const proposalBodyLimit = (path) =>
  createRoute.test(path) ? PROPOSAL_BODY_LIMIT : 8192;
export function createProposalRoutes({ proposals }) {
  return async ({ request, url, credentials, write, method }) => {
    try {
      const creating = url.pathname.match(createRoute);
      if (creating) {
        method(["POST"]);
        write();
        const body = await boundedJson(
          request,
          [
            "baseVersion",
            "selection",
            "replacement",
            "rationale",
            "commandId",
            "disclosure",
            "revises",
          ],
          ["baseVersion", "selection", "replacement", "rationale", "commandId", "disclosure"],
          PROPOSAL_BODY_LIMIT,
        );
        return await proposals.create(
          credentials,
          creating[1],
          creating[2],
          body,
        );
      }
      const reading = url.pathname.match(
        /^\/api\/public\/documents\/([a-f0-9-]{36})\/proposals(?:\/([a-f0-9-]{36}))?$/,
      );
      if (!reading) return null;
      method(["GET"]);
      for (const key of url.searchParams.keys())
        if (
          !["after", "limit"].includes(key) ||
          reading[2] ||
          url.searchParams.getAll(key).length !== 1
        )
          throw new HttpError(400, "INVALID_QUERY");
      if (reading[2]) return await proposals.read(reading[1], reading[2]);
      return await proposals.list(reading[1], {
        after: url.searchParams.get("after"),
        limit: Number(url.searchParams.get("limit") ?? 20),
      });
    } catch (cause) {
      if (cause instanceof DocumentError)
        throw new HttpError(cause.status, cause.code);
      throw cause;
    }
  };
}
