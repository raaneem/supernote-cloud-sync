import type { CloudBrowserSyncStatus } from "./cloud-browser-status";

export interface CloudBrowserFilePresentation {
  statusLabel: string;
  actionLabel: string;
  trailingIcon: "chevron-right" | "download" | "refresh-cw";
}

export const cloudBrowserFilePresentation = (
  status: CloudBrowserSyncStatus,
): CloudBrowserFilePresentation => {
  switch (status) {
    case "downloaded":
    case "mirrored":
    case "writable-sync":
      return {
        statusLabel:
          status === "downloaded"
            ? "Downloaded"
            : status === "mirrored"
              ? "Mirrored"
              : "Paired",
        actionLabel: "Open",
        trailingIcon: "chevron-right",
      };
    case "update-available":
      return {
        statusLabel: "Update available",
        actionLabel: "Update and open",
        trailingIcon: "refresh-cw",
      };
    case "included":
    case "not-synced":
      return {
        statusLabel: status === "included" ? "Mirrored" : "Cloud only",
        actionLabel: "Download and open",
        trailingIcon: "download",
      };
  }
};
