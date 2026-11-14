// Engine-owned console pages. Applications pass these through to bootQuill
// together with their own pages.
import { VerifyPage } from "./verify-page.jsx";
import { TransparencyPage } from "./transparency-page.jsx";

export const enginePages = [
  { path: "/verify", title: "Verify a document", nav: "Transparency", Component: VerifyPage,
    description: "Independently check a published edition against the transparency log and its public-chain anchors." },
  { path: "/transparency", title: "Transparency log", nav: "Transparency", Component: TransparencyPage,
    description: "Signed checkpoints, witness countersignatures and Bitcoin anchoring status for every public record." },
];
