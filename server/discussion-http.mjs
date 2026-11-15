import { boundedJson, HttpError } from "./account-http.mjs";
import { DocumentError } from "./document-store.mjs";
const workspaceRoute =
  /^\/api\/workspaces\/([a-f0-9-]{36})\/documents\/([a-f0-9-]{36})\/proposals\/([a-f0-9-]{36})\/(points|my-point-votes|point-votes|point-merges)(?:\/([a-f0-9-]{36}))?$/;
export const discussionBodyLimit = (path) =>
  path.endsWith("/points") && workspaceRoute.test(path) ? 32768 : 8192;
export function createDiscussionRoutes({ discussion }) {
  return async ({ request, url, credentials, write, method }) => {
    try {
      const historyRoute = url.pathname.match(
        /^\/api\/public\/documents\/([a-f0-9-]{36})\/proposals\/([a-f0-9-]{36})\/points\/([a-f0-9-]{36})\/history$/,
      );
      if (historyRoute) {
        method(["GET"]);
        if (url.search) throw new HttpError(400, "INVALID_QUERY");
        return await discussion.history(historyRoute[1], historyRoute[2], historyRoute[3]);
      }
      const publicRoute = url.pathname.match(
        /^\/api\/public\/documents\/([a-f0-9-]{36})\/proposals\/([a-f0-9-]{36})\/points$/,
      );
      if (publicRoute) {
        method(["GET"]);
        for (const key of url.searchParams.keys())
          if (
            !["position", "parent", "sort", "after", "limit"].includes(key) ||
            url.searchParams.getAll(key).length !== 1
          )
            throw new HttpError(400, "INVALID_QUERY");
        return await discussion.list(publicRoute[1], publicRoute[2], {
          position: url.searchParams.get("position") ?? "all",
          parentId: url.searchParams.get("parent"),
          sort: url.searchParams.get("sort") ?? "top",
          after: url.searchParams.get("after"),
          limit: Number(url.searchParams.get("limit") ?? 10),
        });
      }
      const route = url.pathname.match(workspaceRoute);
      if (!route) return null;
      const [, tenantId, documentId, proposalId, kind, pointId] = route;
      if (kind === "points" && !pointId) {
        method(["POST"]);
        write();
        const body = await boundedJson(
          request,
          [
            "position",
            "parentId",
            "relation",
            "text",
            "evidence",
            "commandId",
            "disclosure",
            "revises",
          ],
          ["position", "text", "commandId", "disclosure"],
          32768,
        );
        return await discussion.create(
          credentials,
          tenantId,
          documentId,
          proposalId,
          body,
        );
      }
      if (kind === "point-votes" && pointId) {
        method(["PUT"]);
        write();
        const body = await boundedJson(request, [
          "value",
          "expectedVoteVersion",
          "commandId",
        ]);
        return await discussion.vote(
          credentials,
          tenantId,
          documentId,
          proposalId,
          pointId,
          body,
        );
      }
      if (kind === "point-merges" && pointId) {
        method(["POST"]);
        write();
        const body = await boundedJson(request, ["duplicateOf", "commandId"]);
        return await discussion.mergeDuplicate(credentials, tenantId, documentId, proposalId, pointId, body);
      }
      if (kind === "my-point-votes" && !pointId) {
        method(["GET"]);
        for (const key of url.searchParams.keys())
          if (key !== "points" || url.searchParams.getAll(key).length !== 1)
            throw new HttpError(400, "INVALID_QUERY");
        const ids = url.searchParams.get("points");
        return await discussion.mine(
          credentials,
          tenantId,
          documentId,
          proposalId,
          { pointIds: ids ? ids.split(",") : [] },
        );
      }
      throw new HttpError(404, "NOT_FOUND");
    } catch (cause) {
      if (cause instanceof DocumentError)
        throw new HttpError(cause.status, cause.code);
      throw cause;
    }
  };
}
