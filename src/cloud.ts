export type CloudMode = "off" | "aliyun" | "put";

export interface CloudConfig {
    mode: CloudMode;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretName: string;
    objectKey: string;
    publicUrl: string;
    uploadUrl: string;
    subscriptionUrl: string;
    headers: string;
}

export const DEFAULT_CLOUD_CONFIG: CloudConfig = {
    mode: "off",
    bucket: "",
    region: "oss-cn-hangzhou",
    accessKeyId: "",
    secretName: "task-secretary-oss-secret",
    objectKey: "siyuan/task-secretary.ics",
    publicUrl: "",
    uploadUrl: "",
    subscriptionUrl: "",
    headers: "{}",
};

export interface PutResult {
    status: number;
}

export type PutObject = (
    url: string,
    content: string,
    headers: Record<string, string>,
    contentType: string,
) => Promise<PutResult>;

export interface UploadRequest {
    url: string;
    contentType: string;
    headers: Record<string, string>;
    subscriptionUrl: string;
    stringToSign?: string;
}

export interface UploadResult {
    url: string;
}

const CONTENT_TYPE = "text/calendar; charset=utf-8";
const encoder = new TextEncoder();

const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
};

const hmacSha1Base64 = async (secret: string, value: string): Promise<string> => {
    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        {name: "HMAC", hash: "SHA-1"},
        false,
        ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
    return bytesToBase64(new Uint8Array(signature));
};

const sanitizeKey = (value: string): string => {
    const key = value.trim().replace(/^\/+/, "").replace(/\.\./g, "");
    if (!key) {
        throw new Error("Object key is empty");
    }
    return key;
};

const encodeKey = (key: string) => key.split("/").map((part) => encodeURIComponent(part)).join("/");

export const buildAliyunRequest = async (config: CloudConfig, secret: string, now = new Date()): Promise<UploadRequest> => {
    const bucket = config.bucket.trim();
    const region = config.region.trim();
    const accessKeyId = config.accessKeyId.trim();
    if (!bucket || !region || !accessKeyId) {
        throw new Error("Aliyun OSS bucket, region and AccessKey ID are required");
    }
    if (!secret) {
        throw new Error("Aliyun OSS AccessKey secret is empty");
    }
    const key = sanitizeKey(config.objectKey);
    const host = `${bucket}.${region}.aliyuncs.com`;
    const url = `https://${host}/${encodeKey(key)}`;
    const date = now.toUTCString();
    const stringToSign = `PUT\n\n${CONTENT_TYPE}\n${date}\n/${bucket}/${key}`;
    const signature = await hmacSha1Base64(secret, stringToSign);
    return {
        url,
        contentType: CONTENT_TYPE,
        headers: {
            Authorization: `OSS ${accessKeyId}:${signature}`,
            Date: date,
            "Cache-Control": "no-cache, max-age=0",
        },
        subscriptionUrl: config.publicUrl.trim() || url,
        stringToSign,
    };
};

export const buildPutRequest = (config: CloudConfig): UploadRequest => {
    const url = config.uploadUrl.trim();
    if (!url) {
        throw new Error("Upload URL is required");
    }
    let parsed: Record<string, unknown> = {};
    if (config.headers.trim()) {
        try {
            parsed = JSON.parse(config.headers) as Record<string, unknown>;
        } catch (error) {
            throw new Error(`Upload headers must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Upload headers must be a JSON object");
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed)) {
        headers[name] = String(value);
    }
    return {
        url,
        contentType: CONTENT_TYPE,
        headers,
        subscriptionUrl: config.subscriptionUrl.trim() || url,
    };
};

export const uploadICS = async (
    content: string,
    config: CloudConfig,
    getSecret: (name: string) => string,
    put: PutObject,
): Promise<UploadResult> => {
    if (config.mode === "off") {
        throw new Error("Cloud upload is not configured");
    }

    let request: UploadRequest;
    if (config.mode === "aliyun") {
        const secretName = config.secretName.trim();
        if (!secretName) {
            throw new Error("Secret name is required for Aliyun OSS");
        }
        request = await buildAliyunRequest(config, getSecret(secretName));
    } else {
        request = buildPutRequest(config);
    }

    const result = await put(request.url, content, request.headers, request.contentType);
    if (result.status < 200 || result.status >= 300) {
        throw new Error(`Upload failed: HTTP ${result.status}`);
    }
    return {url: request.subscriptionUrl};
};
