import SparkMD5 from "spark-md5";

import { md5, sameMd5 } from "../shared/md5";
import type {
  CloudDirectory,
  CloudDownloadPort,
  CloudFile,
  CloudItem,
  CloudUploadPort,
  DownloadDescriptor,
  UploadResult,
} from "./types";
import {
  isValidVerificationCode,
  normalizeVerificationCode,
} from "./verification-code";

const BASE_URL = "https://cloud.supernote.com/api";

export interface RequestOptions {
  url: string;
  method: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}

export interface RequestResponse {
  status: number;
  headers?: Record<string, string>;
  json: unknown;
  arrayBuffer: ArrayBuffer;
}

export type RequestExecutor = (
  options: RequestOptions,
) => Promise<RequestResponse>;

export class SupernoteApiError extends Error {}
export class SupernoteAuthExpiredError extends SupernoteApiError {}

export interface SupernoteVerificationChallenge {
  email: string;
  timestamp: string;
  validCodeKey: string;
}

export interface SupernoteVerificationRequired {
  status: "verification-required";
  challenge: SupernoteVerificationChallenge;
}

interface ApiObject {
  [key: string]: unknown;
}

const asObject = (value: unknown, context: string): ApiObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SupernoteApiError(`Invalid ${context} response`);
  }
  return value as ApiObject;
};

const asString = (value: unknown, field: string): string => {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new SupernoteApiError(`Missing ${field} in Supernote response`);
  }
  return String(value);
};

const asNumber = (value: unknown, field: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new SupernoteApiError(`Invalid ${field} in Supernote response`);
  }
  return parsed;
};

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const toCloudItem = (rawValue: unknown): CloudItem => {
  const raw = asObject(rawValue, "file listing");
  const isFolder = raw.isFolder === "Y";
  const item = {
    id: asString(raw.id, "id"),
    directoryId: asString(raw.directoryId, "directoryId"),
    fileName: asString(raw.fileName, "fileName"),
    isFolder,
    md5: typeof raw.md5 === "string" ? raw.md5 : "",
    size: asNumber(raw.size ?? 0, "size"),
    createTime: asNumber(raw.createTime ?? 0, "createTime"),
    updateTime: asNumber(raw.updateTime ?? 0, "updateTime"),
  };
  return isFolder ? (item as CloudDirectory) : (item as CloudFile);
};

export class SupernoteCloudClient
  implements CloudDownloadPort, CloudUploadPort
{
  private token: string | null;
  private csrfToken: string | null = null;

  constructor(
    token: string | null,
    private readonly request: RequestExecutor,
    private readonly pageSize = 100,
  ) {
    this.token = token;
  }

  get accessToken(): string | null {
    return this.token;
  }

  async login(
    email: string,
    password: string,
  ): Promise<string | SupernoteVerificationRequired> {
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) {
      throw new SupernoteApiError("Email and password are required");
    }

    const randomResponse = await this.postApi(
      "/official/user/query/random/code",
      { countryCode: "1", account: normalizedEmail },
      false,
    );
    const randomCode = asString(randomResponse.randomCode, "randomCode");
    const timestamp = asString(randomResponse.timestamp, "timestamp");
    const passwordHash = await sha256(
      `${SparkMD5.hash(password)}${randomCode}`,
    );

    const loginResponse = await this.postApi(
      "/official/user/account/login/new",
      {
        countryCode: 1,
        account: normalizedEmail,
        password: passwordHash,
        browser: "Chrome107",
        equipment: "1",
        loginMethod: "1",
        timestamp,
        language: "en",
      },
      false,
      true,
    );
    if (
      loginResponse.success === false &&
      loginResponse.errorCode === "E1760"
    ) {
      return {
        status: "verification-required",
        challenge: await this.requestVerificationCode({
          email: normalizedEmail,
          timestamp,
        }),
      };
    }
    if (loginResponse.success === false) {
      throw new SupernoteApiError(
        typeof loginResponse.errorMsg === "string"
          ? loginResponse.errorMsg
          : "Supernote Cloud rejected the login",
      );
    }

    const token = asString(loginResponse.token, "token");
    this.token = token;
    return token;
  }

  async resendVerificationCode(
    challenge: SupernoteVerificationChallenge,
  ): Promise<SupernoteVerificationChallenge> {
    return this.requestVerificationCode({
      email: challenge.email,
      timestamp: challenge.timestamp,
    });
  }

  async verifyLogin(
    challenge: SupernoteVerificationChallenge,
    verificationCode: string,
  ): Promise<string> {
    const code = normalizeVerificationCode(verificationCode);
    if (!isValidVerificationCode(code)) {
      throw new SupernoteApiError(
        "Enter the six-character Supernote verification code",
      );
    }

    const response = await this.postApi(
      "/official/user/sms/login",
      {
        email: challenge.email,
        validCode: code,
        validCodeKey: challenge.validCodeKey,
        timestamp: challenge.timestamp,
        browser: "Chrome107",
        equipment: "4",
      },
      false,
    );
    const token = asString(response.token, "token");
    this.token = token;
    return token;
  }

  logout(): void {
    this.token = null;
  }

  async listDirectory(directoryId: string): Promise<CloudItem[]> {
    this.requireToken();
    const items: CloudItem[] = [];
    let pageNumber = 1;
    let total = Number.POSITIVE_INFINITY;

    while (items.length < total) {
      const response = await this.postApi("/file/list/query", {
        directoryId: directoryId === "0" ? 0 : directoryId,
        pageNo: pageNumber,
        pageSize: this.pageSize,
        order: "time",
        sequence: "desc",
      });
      const rawItems = response.userFileVOList;
      if (!Array.isArray(rawItems)) {
        throw new SupernoteApiError(
          "Supernote folder response did not include a file list",
        );
      }
      total = asNumber(response.total ?? rawItems.length, "total");
      items.push(...rawItems.map(toCloudItem));

      if (rawItems.length === 0 && items.length < total) {
        throw new SupernoteApiError(
          "Supernote pagination stopped before all files were returned",
        );
      }
      pageNumber += 1;
    }

    return items;
  }

  async getDownloadDescriptor(fileId: string): Promise<DownloadDescriptor> {
    this.requireToken();
    const response = await this.postApi("/file/download/url", {
      id: fileId,
      type: 0,
    });
    return {
      url: asString(response.url, "download URL"),
      md5: asString(response.md5, "md5"),
    };
  }

  async download(url: string): Promise<Uint8Array> {
    const response = await this.request({ url, method: "GET" });
    this.assertHttpStatus(response.status);
    return new Uint8Array(response.arrayBuffer);
  }

  async createDirectory(
    parentDirectoryId: string,
    name: string,
  ): Promise<void> {
    await this.postApi("/file/folder/add", {
      directoryId: parentDirectoryId === "0" ? 0 : parentDirectoryId,
      fileName: name,
    });
  }

  async uploadFile(
    directoryId: string,
    fileName: string,
    bytes: Uint8Array,
  ): Promise<UploadResult> {
    const body = Uint8Array.from(bytes);
    const checksum = md5(body);
    try {
      const apply = await this.postApi("/file/upload/apply", {
        directoryId,
        fileName,
        md5: checksum,
        size: body.byteLength,
      });
      const url = asString(apply.url, "upload URL");
      const authorization = asString(apply.s3Authorization, "S3 authorization");
      const amzDate = asString(apply.xamzDate, "S3 upload date");
      const upload = await this.request({
        url,
        method: "PUT",
        headers: {
          Authorization: authorization,
          "x-amz-date": amzDate,
          "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
        },
        body: body.buffer,
      });
      this.assertHttpStatus(upload.status);

      const urlPath = new URL(url).pathname;
      const innerName =
        typeof apply.innerName === "string" && apply.innerName
          ? apply.innerName
          : urlPath.slice(urlPath.lastIndexOf("/") + 1);
      if (!innerName) {
        throw new SupernoteApiError(
          "Supernote did not return an upload object name",
        );
      }
      await this.postApi("/file/upload/finish", {
        directoryId,
        fileName,
        fileSize: body.byteLength,
        innerName,
        md5: checksum,
      });
      return { md5: checksum };
    } catch (error) {
      const size = (body.byteLength / (1024 * 1024)).toFixed(1);
      throw new SupernoteApiError(
        `Upload failed for ${fileName} (${size} MB): ${
          error instanceof Error ? error.message : "unknown cloud error"
        }`,
        { cause: error },
      );
    }
  }

  async replaceFile(file: CloudFile, bytes: Uint8Array): Promise<UploadResult> {
    // The live web API treats same-name upload/finish as create-only.
    // Stage verified bytes first so replacing the catalog entry cannot
    // discard the previous version before the new upload exists.
    const checksum = md5(bytes);
    const extensionAt = file.fileName.lastIndexOf(".");
    const extension = extensionAt > 0 ? file.fileName.slice(extensionAt) : "";
    const stem =
      extensionAt > 0 ? file.fileName.slice(0, extensionAt) : file.fileName;
    const stagingName =
      `${stem.slice(0, 80)}.obsidian-${checksum.slice(0, 8)}` + extension;

    try {
      await this.uploadFile(file.directoryId, stagingName, bytes);
      const staged = (await this.listDirectory(file.directoryId)).find(
        (item): item is CloudFile =>
          !item.isFolder &&
          item.fileName === stagingName &&
          sameMd5(item.md5, checksum),
      );
      if (!staged) {
        throw new SupernoteApiError(
          `Supernote did not list the verified staging upload for ${file.fileName}`,
        );
      }

      await this.postApi("/file/delete", {
        directoryId: file.directoryId,
        idList: [file.id],
      });
      try {
        await this.postApi("/file/rename", {
          id: staged.id,
          newName: file.fileName,
        });
      } catch (renameError) {
        let restored = false;
        try {
          await this.postApi("/file/recycle/revert", { id: file.id });
          restored = true;
        } catch {
          // The old version remains recoverable in Supernote's recycle bin.
        }
        throw new SupernoteApiError(
          `Could not finalize replacement for ${file.fileName}; ${
            restored
              ? "the previous cloud file was restored"
              : "the previous cloud file remains in the recycle bin"
          }`,
          { cause: renameError },
        );
      }
      return { md5: checksum };
    } catch (error) {
      if (error instanceof SupernoteApiError) {
        throw error;
      }
      throw new SupernoteApiError(
        `Replacement failed for ${file.fileName}: ${
          error instanceof Error ? error.message : "unknown cloud error"
        }`,
        { cause: error },
      );
    }
  }

  async recycleItem(item: CloudItem): Promise<void> {
    await this.postApi("/file/delete", {
      directoryId: item.directoryId,
      idList: [item.id],
    });
  }

  private requireToken(): string {
    if (!this.token) {
      throw new SupernoteAuthExpiredError(
        "Log in to Supernote Cloud before syncing",
      );
    }
    return this.token;
  }

  private async postApi(
    path: string,
    payload: Record<string, unknown>,
    authenticated = true,
    allowApiFailure = false,
    allowCsrfRetry = true,
  ): Promise<ApiObject> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (authenticated) {
      headers["x-access-token"] = this.requireToken();
    }
    if (this.csrfToken) {
      headers["X-XSRF-TOKEN"] = this.csrfToken;
    }

    const response = await this.request({
      url: `${BASE_URL}${path}`,
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    this.captureCsrfToken(response.headers);
    const json = asObject(response.json, "API");
    if (
      response.status === 403 &&
      allowCsrfRetry &&
      this.shouldRefreshCsrf(json)
    ) {
      await this.refreshCsrf();
      return this.postApi(path, payload, authenticated, allowApiFailure, false);
    }
    if (
      (response.status === 401 || response.status === 403) &&
      !authenticated &&
      allowApiFailure
    ) {
      return json;
    }
    if (
      (response.status === 401 || response.status === 403) &&
      !authenticated
    ) {
      throw new SupernoteApiError(
        typeof json.errorMsg === "string"
          ? json.errorMsg
          : "Supernote could not verify this login",
      );
    }
    this.assertHttpStatus(response.status);

    if (json.success === false && !allowApiFailure) {
      const message =
        typeof json.errorMsg === "string"
          ? json.errorMsg
          : "Supernote Cloud rejected the request";
      throw new SupernoteApiError(message);
    }
    return json;
  }

  private shouldRefreshCsrf(response: ApiObject): boolean {
    return (
      response.errorCode === undefined ||
      response.code === "CSRF_TOKEN_EXPIRED" ||
      response.code === "INVALID_CSRF_TOKEN"
    );
  }

  private async refreshCsrf(): Promise<void> {
    const response = await this.request({
      url: `${BASE_URL}/csrf`,
      method: "GET",
    });
    this.assertHttpStatus(response.status);
    this.captureCsrfToken(response.headers);
    if (!this.csrfToken) {
      throw new SupernoteApiError(
        "Supernote did not return a CSRF verification token",
      );
    }
  }

  private captureCsrfToken(headers: Record<string, string> | undefined): void {
    if (!headers) {
      return;
    }
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLocaleLowerCase() === "x-xsrf-token" && value) {
        this.csrfToken = value;
        return;
      }
    }
  }

  private async requestVerificationCode({
    email,
    timestamp,
  }: {
    email: string;
    timestamp: string;
  }): Promise<SupernoteVerificationChallenge> {
    const preAuth = await this.postApi(
      "/user/validcode/pre-auth",
      { account: email },
      false,
    );
    const preAuthToken = asString(preAuth.token, "pre-auth token");
    const tokenParts = preAuthToken.split("-");
    const keyIndex = Number(preAuthToken.at(-1));
    const realKey = tokenParts[keyIndex];
    if (!Number.isInteger(keyIndex) || !realKey) {
      throw new SupernoteApiError(
        "Supernote returned an invalid verification token",
      );
    }

    const response = await this.postApi(
      "/user/mail/validcode/send",
      {
        email,
        timestamp,
        token: preAuthToken,
        sign: await sha256(`${email}${realKey}`),
      },
      false,
    );
    return {
      email,
      timestamp,
      validCodeKey: asString(response.validCodeKey, "validCodeKey"),
    };
  }

  private assertHttpStatus(status: number): void {
    if (status === 401 || status === 403) {
      throw new SupernoteAuthExpiredError(
        "Your Supernote Cloud session expired. Log in again.",
      );
    }
    if (status < 200 || status >= 300) {
      throw new SupernoteApiError(`Supernote Cloud returned HTTP ${status}`);
    }
  }
}
