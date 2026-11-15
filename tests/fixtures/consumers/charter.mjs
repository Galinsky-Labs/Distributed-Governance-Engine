// Consumer fixture mirroring CharterQuill's extension shape (no product logic).
export const charterFixture = {
  id: "charter",
  migrations: [{ name: "001-charter.sql", sql: "SELECT 1" }],
  pagePaths: ["/charter/meetings"],
  createRoutes: (services) => [{ routes: async () => null, bodyLimit: () => 0, services }],
};
export const charterManifest = { engine: "^1.1.0", profile: "charter", capabilities: ["identity", "decisions", "electorates", "signatures"], surfaces: ["routes", "migrations", "pages"] };
