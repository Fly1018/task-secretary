import {fetchSyncPost} from "siyuan";
import type {PutObject, PutResult} from "./cloud";

const encoder = new TextEncoder();

const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
};

export const forwardProxyPut: PutObject = async (
    url: string,
    content: string,
    headers: Record<string, string>,
    contentType: string,
): Promise<PutResult> => {
    const response = await fetchSyncPost("/api/network/forwardProxy", {
        url,
        method: "PUT",
        timeout: 30000,
        contentType,
        headers: Object.entries(headers).map(([name, value]) => ({[name]: value})),
        payload: bytesToBase64(encoder.encode(content)),
        payloadEncoding: "base64",
        responseEncoding: "text",
    });
    if (response.code !== 0) {
        throw new Error(response.msg || `Forward proxy failed: ${response.code}`);
    }
    const status = Number(response.data?.status || 0);
    if (status < 200 || status >= 300) {
        const body = String(response.data?.body || "").slice(0, 200);
        throw new Error(`Upload failed: HTTP ${status}${body ? ` - ${body}` : ""}`);
    }
    return {status};
};
