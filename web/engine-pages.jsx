// Engine-owned console pages. Applications pass these through to bootQuill
// together with their own pages.
import { VerifyPage } from "./verify-page.jsx";
import { TransparencyPage } from "./transparency-page.jsx";
import { ImportPage, ExportPage } from "./document-io-pages.jsx";

export const enginePages = [
  { path: "/documents/import", title: "Import a document", nav: "Documents", Component: ImportPage,
    description: "Convert Word, OpenDocument, HTML, text or PDF text into an editable legal draft after reviewing the conversion." },
  { path: "/documents/export", title: "Export and print", nav: "Documents", Component: ExportPage,
    description: "Bound PDF, Word, HTML, text and redline downloads of exact saved editions." },
  { path: "/verify", title: "Verify a document", nav: "Transparency", Component: VerifyPage,
    description: "Independently check a published edition against the transparency log and its public-chain anchors." },
  { path: "/transparency", title: "Transparency log", nav: "Transparency", Component: TransparencyPage,
    description: "Signed checkpoints, witness countersignatures and Bitcoin anchoring status for every public record." },
];
