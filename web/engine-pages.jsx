// Engine-owned console pages. Applications pass these through to bootQuill
// together with their own pages.
import { VerifyPage } from "./verify-page.jsx";
import { TransparencyPage } from "./transparency-page.jsx";
import { ImportPage, ExportPage } from "./document-io-pages.jsx";
import { SearchPage, NotificationsPage, UnsubscribePage, VerifyEmailPage, EditionsPage, SignersPage, AdminPage, BillingPage, ElectoratesPage, ModerationPage, ClauseAccessPage } from "./feature-pages.jsx";

export const enginePages = [
  { path: "/governance/electorates", title: "Electorates and proxies", nav: "Governance", Component: ElectoratesPage,
    description: "Rosters with exact voting units and classes, record-date snapshots, verified-person cohorts and proxy grants." },
  { path: "/governance/clause-access", title: "Clause access", nav: "Governance", Component: ClauseAccessPage,
    description: "Open selected sections to selected roles, accounts or classes to propose, discuss or vote, with expirations." },
  { path: "/governance/moderation", title: "Moderation and appeals", nav: "Governance", Component: ModerationPage },
  { path: "/admin", title: "Settings and policy", nav: "Administration", Component: AdminPage },
  { path: "/billing", title: "Plans and allowances", nav: "Account", Component: BillingPage },
  { path: "/search", title: "Search", nav: "Documents", Component: SearchPage },
  { path: "/editions", title: "Final editions and signatures", nav: "Documents", Component: EditionsPage,
    description: "Freeze an exact edition, then collect support signatures, approvals or legal execution with recorded intent and capacity." },
  { path: "/signers", title: "Signer directory", Component: SignersPage },
  { path: "/notifications", title: "Notifications", nav: "Account", Component: NotificationsPage },
  { path: "/notifications/unsubscribe", title: "Unsubscribe", Component: UnsubscribePage },
  { path: "/notifications/verify-email", title: "Verify email", Component: VerifyEmailPage },
  { path: "/documents/import", title: "Import a document", nav: "Documents", Component: ImportPage,
    description: "Convert Word, OpenDocument, HTML, text or PDF text into an editable legal draft after reviewing the conversion." },
  { path: "/documents/export", title: "Export and print", nav: "Documents", Component: ExportPage,
    description: "Bound PDF, Word, HTML, text and redline downloads of exact saved editions." },
  { path: "/verify", title: "Verify a document", nav: "Transparency", Component: VerifyPage,
    description: "Independently check a published edition against the transparency log and its public-chain anchors." },
  { path: "/transparency", title: "Transparency log", nav: "Transparency", Component: TransparencyPage,
    description: "Signed checkpoints, witness countersignatures and Bitcoin anchoring status for every public record." },
];
