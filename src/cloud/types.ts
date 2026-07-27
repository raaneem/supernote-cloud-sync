export interface CloudItem {
  id: string;
  directoryId: string;
  fileName: string;
  isFolder: boolean;
  md5: string;
  size: number;
  createTime: number;
  updateTime: number;
}

export type CloudFile = CloudItem & { isFolder: false };
export type CloudDirectory = CloudItem & { isFolder: true };

export interface DownloadDescriptor {
  url: string;
  md5: string;
}

export interface CloudDownloadPort {
  getDownloadDescriptor(fileId: string): Promise<DownloadDescriptor>;
  download(url: string): Promise<Uint8Array>;
}

export interface UploadResult {
  md5: string;
}

export interface CloudUploadPort {
  createDirectory(parentDirectoryId: string, name: string): Promise<void>;
  uploadFile(
    directoryId: string,
    fileName: string,
    bytes: Uint8Array,
  ): Promise<UploadResult>;
  replaceFile(file: CloudFile, bytes: Uint8Array): Promise<UploadResult>;
}
