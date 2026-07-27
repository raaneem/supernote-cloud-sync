import { describe, expect, it, vi } from "vitest";
import SparkMD5 from "spark-md5";

import {
  SupernoteCloudClient,
  type RequestExecutor,
} from "../src/cloud/client";

describe("SupernoteCloudClient", () => {
  it("paginates folder listings until the reported total is reached", async () => {
    const request: RequestExecutor = vi.fn(async (options) => {
      const body = JSON.parse((options.body as string | undefined) ?? "{}") as {
        pageNo: number;
      };
      return {
        status: 200,
        json: {
          success: true,
          total: 3,
          userFileVOList:
            body.pageNo === 1
              ? [
                  {
                    id: 1,
                    directoryId: 0,
                    fileName: "Note",
                    isFolder: "Y",
                    md5: "",
                    size: 0,
                    createTime: 1,
                    updateTime: 2,
                  },
                  {
                    id: 2,
                    directoryId: 0,
                    fileName: "Journal.note",
                    isFolder: "N",
                    md5: "abc",
                    size: 99,
                    createTime: 1,
                    updateTime: 2,
                  },
                ]
              : [
                  {
                    id: 3,
                    directoryId: 0,
                    fileName: "Archive",
                    isFolder: "Y",
                    md5: "",
                    size: 0,
                    createTime: 1,
                    updateTime: 2,
                  },
                ],
        },
        arrayBuffer: new ArrayBuffer(0),
      };
    });
    const client = new SupernoteCloudClient("token", request, 2);

    const items = await client.listDirectory("0");

    expect(items.map((item) => item.fileName)).toEqual([
      "Note",
      "Journal.note",
      "Archive",
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("preserves opaque directory IDs when requesting a folder", async () => {
    const directoryId = "<account-id>";
    const request: RequestExecutor = vi.fn().mockResolvedValue({
      status: 200,
      json: {
        success: true,
        total: 0,
        userFileVOList: [],
      },
      arrayBuffer: new ArrayBuffer(0),
    });
    const client = new SupernoteCloudClient("token", request);

    await client.listDirectory(directoryId);

    const listRequest = vi.mocked(request).mock.calls[0]?.[0];
    expect(
      JSON.parse((listRequest?.body as string | undefined) ?? "{}"),
    ).toMatchObject({
      directoryId,
    });
  });

  it("exchanges credentials for a token without retaining the password", async () => {
    const request: RequestExecutor = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: { success: true, randomCode: "salt", timestamp: "123" },
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: { success: true, token: "session-token" },
        arrayBuffer: new ArrayBuffer(0),
      });
    const client = new SupernoteCloudClient(null, request);

    await expect(client.login("person@example.com", "secret")).resolves.toBe(
      "session-token",
    );
    expect(client.accessToken).toBe("session-token");
    const loginRequest = vi.mocked(request).mock.calls[1]?.[0];
    expect(loginRequest?.body).not.toContain("secret");
  });

  it("starts email verification when Supernote requires a second factor", async () => {
    const request: RequestExecutor = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: { success: true, randomCode: "salt", timestamp: "123" },
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        status: 403,
        json: {
          success: false,
          errorCode: "E1760",
          errorMsg: "Identity verification required",
        },
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        status: 403,
        json: {},
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: { "x-xsrf-token": "csrf-token" },
        json: {},
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: {
          success: true,
          token: "part-zero-part-one-part-two-2",
        },
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: { success: true, validCodeKey: "verification-key" },
        arrayBuffer: new ArrayBuffer(0),
      });
    const client = new SupernoteCloudClient(null, request);

    await expect(client.login("person@example.com", "secret")).resolves.toEqual(
      {
        status: "verification-required",
        challenge: {
          email: "person@example.com",
          timestamp: "123",
          validCodeKey: "verification-key",
        },
      },
    );

    const preAuthRetry = vi.mocked(request).mock.calls[4]?.[0];
    expect(preAuthRetry?.url).toMatch(/\/user\/validcode\/pre-auth$/);
    expect(preAuthRetry?.headers).toMatchObject({
      "X-XSRF-TOKEN": "csrf-token",
    });

    const sendCodeRequest = vi.mocked(request).mock.calls[5]?.[0];
    expect(sendCodeRequest?.url).toMatch(/\/user\/mail\/validcode\/send$/);
    expect(sendCodeRequest?.body).not.toContain("secret");
  });

  it("exchanges a verification code for the final session token", async () => {
    const request: RequestExecutor = vi.fn().mockResolvedValueOnce({
      status: 200,
      json: {
        success: true,
        token: "verified-session-token",
        userName: "person",
      },
      arrayBuffer: new ArrayBuffer(0),
    });
    const client = new SupernoteCloudClient(null, request);

    await expect(
      client.verifyLogin(
        {
          email: "person@example.com",
          timestamp: "123",
          validCodeKey: "verification-key",
        },
        "d7a6bs",
      ),
    ).resolves.toBe("verified-session-token");
    expect(client.accessToken).toBe("verified-session-token");

    const verificationRequest = vi.mocked(request).mock.calls[0]?.[0];
    expect(verificationRequest?.url).toMatch(/\/official\/user\/sms\/login$/);
    expect(
      JSON.parse((verificationRequest?.body as string | undefined) ?? "{}"),
    ).toMatchObject({
      email: "person@example.com",
      validCode: "D7A6BS",
      validCodeKey: "verification-key",
      equipment: "4",
    });
  });

  it("creates a cloud folder with the web API schema", async () => {
    const request: RequestExecutor = vi.fn().mockResolvedValue({
      status: 200,
      json: { success: true },
      arrayBuffer: new ArrayBuffer(0),
    });
    const client = new SupernoteCloudClient("token", request);

    await client.createDirectory("parent-directory", "Obsidian");

    const call = vi.mocked(request).mock.calls[0]?.[0];
    expect(call?.url).toMatch(/\/file\/folder\/add$/);
    expect(JSON.parse(call?.body as string)).toEqual({
      directoryId: "parent-directory",
      fileName: "Obsidian",
    });
  });

  it("uploads raw bytes through apply, signed PUT, and finish", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const request: RequestExecutor = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: {
          success: true,
          s3Authorization: "signed-authorization",
          xamzDate: "20260724T120000Z",
          url: "https://storage.example/uploads/inner-file",
        },
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: null,
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: { success: true },
        arrayBuffer: new ArrayBuffer(0),
      });
    const client = new SupernoteCloudClient("token", request);

    const result = await client.uploadFile("directory", "Report.pdf", bytes);

    expect(result.md5).toMatch(/^[a-f0-9]{32}$/);
    const apply = vi.mocked(request).mock.calls[0]?.[0];
    expect(apply?.url).toMatch(/\/file\/upload\/apply$/);
    expect(JSON.parse(apply?.body as string)).toEqual({
      directoryId: "directory",
      fileName: "Report.pdf",
      md5: result.md5,
      size: 3,
    });

    const put = vi.mocked(request).mock.calls[1]?.[0];
    expect(put).toMatchObject({
      url: "https://storage.example/uploads/inner-file",
      method: "PUT",
      headers: {
        Authorization: "signed-authorization",
        "x-amz-date": "20260724T120000Z",
        "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
      },
    });
    expect(new Uint8Array(put?.body as ArrayBuffer)).toEqual(bytes);

    const finish = vi.mocked(request).mock.calls[2]?.[0];
    expect(finish?.url).toMatch(/\/file\/upload\/finish$/);
    expect(JSON.parse(finish?.body as string)).toEqual({
      directoryId: "directory",
      fileName: "Report.pdf",
      fileSize: 3,
      innerName: "inner-file",
      md5: result.md5,
    });
  });

  it("replaces an existing file through a verified staging upload", async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const request: RequestExecutor = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        json: {
          success: true,
          s3Authorization: "signed",
          xamzDate: "date",
          url: "https://storage.example/staged-object",
          innerName: "staged-object",
        },
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: null,
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: { success: true },
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockImplementationOnce(async (_options) => {
        const apply = vi.mocked(request).mock.calls[0]?.[0];
        const stagingName = JSON.parse(apply?.body as string)
          .fileName as string;
        return {
          status: 200,
          json: {
            success: true,
            total: 1,
            userFileVOList: [
              {
                id: "staged-id",
                directoryId: "directory",
                fileName: stagingName,
                isFolder: "N",
                md5: SparkMD5.ArrayBuffer.hash(bytes.buffer),
                size: bytes.byteLength,
                createTime: 1,
                updateTime: 2,
              },
            ],
          },
          arrayBuffer: new ArrayBuffer(0),
        };
      })
      .mockResolvedValueOnce({
        status: 200,
        json: { success: true },
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: { success: true },
        arrayBuffer: new ArrayBuffer(0),
      });
    const client = new SupernoteCloudClient("token", request);

    await client.replaceFile(
      {
        id: "existing-id",
        directoryId: "directory",
        fileName: "Report.pdf",
        isFolder: false,
        md5: "old-md5",
        size: 1,
        createTime: 1,
        updateTime: 1,
      },
      bytes,
    );

    const deleteRequest = vi.mocked(request).mock.calls[4]?.[0];
    expect(deleteRequest?.url).toMatch(/\/file\/delete$/);
    expect(JSON.parse(deleteRequest?.body as string)).toEqual({
      directoryId: "directory",
      idList: ["existing-id"],
    });
    const renameRequest = vi.mocked(request).mock.calls[5]?.[0];
    expect(renameRequest?.url).toMatch(/\/file\/rename$/);
    expect(JSON.parse(renameRequest?.body as string)).toEqual({
      id: "staged-id",
      newName: "Report.pdf",
    });
  });
});
