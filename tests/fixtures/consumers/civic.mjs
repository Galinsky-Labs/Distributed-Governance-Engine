// Consumer fixture mirroring CivicQuill's extension shape (no product logic).
export const civicFixture = {
  id: "civic",
  migrations: [{ name: "001-civic.sql", sql: "SELECT 1" }],
  pagePaths: ["/civic/bills"],
  createRoutes: (services) => [{ routes: async () => null, bodyLimit: () => 0, services }],
};
export const civicManifest = { engine: "^1.0.0", profile: "civic", capabilities: ["identity", "documents:read", "decisions", "notifications"], surfaces: ["routes", "migrations", "pages"] };
