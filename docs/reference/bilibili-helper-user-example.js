/*
 * НАСТРОЙКА UNIVERSAL MEDIA PROXY
 *
 * Перед использованием укажите адрес своего сервера UMP.
 *
 * Найдите метод:
 *   async registerProxyVideo(bvid, page)
 *
 * И замените:
 *   const proxyBase = "https://media-proxy.org";
 *
 * На:
 *   const proxyBase = "https://ваш-домен";
 *
 * Указывайте адрес с https://, без завершающего слеша.
 */
import { BaseHelper } from "./base.js";
export default class BilibiliHelper extends BaseHelper {
    getVideoElement() {
        return document.querySelector("video");
    }
    getBilibiliVideoId(url) {
        const bangumiId = /\/bangumi\/play\/([^/?#]+)/.exec(url.pathname)?.[1];
        if (bangumiId)
            return `bangumi/play/${bangumiId}`;
        const cheeseId = /\/cheese\/play\/([^/?#]+)/.exec(url.pathname)?.[1];
        if (cheeseId)
            return `cheese/play/${cheeseId}`;
        const bvid = window.__INITIAL_STATE__?.bvid ||
            window.__INITIAL_STATE__?.videoData?.bvid ||
            url.searchParams.get("bvid") ||
            /\/video\/(BV[^/?#]+)/.exec(url.pathname)?.[1];
        if (bvid) {
            const p = url.searchParams.get("p");
            return `video/${bvid}${p ? `/?p=${p}` : ""}`;
        }
        return /video\/[^/?#]+/.exec(url.pathname)?.[0];
    }
    getBvidAndCid(url) {
        const bvid = window.__INITIAL_STATE__?.bvid ||
            window.__INITIAL_STATE__?.videoData?.bvid ||
            /\/video\/(BV[^/?#]+)/.exec(url.pathname)?.[1] ||
            url.searchParams.get("bvid");
        const cid = window.__INITIAL_STATE__?.cid ||
            window.__INITIAL_STATE__?.videoData?.cid ||
            window.__INITIAL_STATE__?.videoData?.pages?.[0]?.cid;
        return { bvid, cid };
    }
    async getCidByBvid(bvid) {
        if (!bvid)
            return undefined;
        try {
            const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, { credentials: "include" });
            const json = await r.json();
            return json?.data?.pages?.[0]?.cid;
        }
        catch {
            return undefined;
        }
    }
    async getVideoUrlFromApi(bvid, cid) {
        if (!bvid || !cid)
            return undefined;
        try {
            const r = await fetch(`https://api.bilibili.com/x/player/playurl` +
                `?bvid=${encodeURIComponent(bvid)}` +
                `&cid=${encodeURIComponent(cid)}` +
                `&qn=16&type=mp4&platform=html5&high_quality=0`, { credentials: "include" });
            const json = await r.json();
            return (json?.data?.durl?.[0]?.url ||
                json?.durl?.[0]?.url);
        }
        catch {
            return undefined;
        }
    }
    async registerProxyVideo(bvid, page) {
        const proxyBase = "https://media-proxy.org";
        if (!/^BV[A-Za-z0-9]{8,20}$/.test(bvid) || !Number.isSafeInteger(page) || page < 1 || page > 1000)
            return undefined;
        return new Promise(resolve => {
            if (typeof GM_xmlhttpRequest === "undefined") return resolve(undefined);
            GM_xmlhttpRequest({
                method: "POST",
                url: `${proxyBase}/api/bilibili/register`,
                headers: { "Content-Type": "application/json" },
                data: JSON.stringify({ bvid, page }),
                timeout: 10000,
                onload: res => {
                    if (res.status !== 200) return resolve(undefined);
                    try {
                        const mediaUrl = JSON.parse(res.responseText).mediaUrl;
                        const parsed = new URL(mediaUrl);
                        resolve(parsed.origin === proxyBase &&
                            parsed.pathname === `/media/bilibili/${bvid}/p${page}/audio.m4a` &&
                            !parsed.search && !parsed.hash ? mediaUrl : undefined);
                    } catch { resolve(undefined); }
                },
                onerror: () => resolve(undefined),
                ontimeout: () => resolve(undefined),
            });
        });
    }
    async getVideoData() {
        const currentUrl = new URL(location.href);
        const video = this.getVideoElement();
        const videoId = this.getBilibiliVideoId(currentUrl);
        if (!videoId)
            return undefined;
        const bvid = /\/video\/(BV[A-Za-z0-9]+)/i.exec(currentUrl.pathname)?.[1] ||
            window.__INITIAL_STATE__?.bvid ||
            window.__INITIAL_STATE__?.videoData?.bvid;
        if (bvid) {
            const rawPage = currentUrl.searchParams.get("p") || "1";
            const page = /^[1-9]\d*$/.test(rawPage) && Number(rawPage) <= 1000 ? rawPage : "1";
            const mediaUrl = await this.registerProxyVideo(bvid, Number(page));
            if (!mediaUrl) {
                console.warn("[VOT][bilibili] UMP registration failed; translation skipped");
                return undefined;
            }
            return {
                url: mediaUrl,
                videoId,
                host: "bilibili",
                duration: video?.duration,
                isStream: false,
            };
        }
        if (/^(cheese|bangumi)\/play\//.test(videoId)) {
            return {
                url: `${currentUrl.origin}/${videoId}`,
                videoId,
                host: "bilibili",
                duration: video?.duration,
                isStream: false,
            };
        }
        return undefined;
    }
    async getVideoId(url) {
        return this.getBilibiliVideoId(url);
    }
}
