import { assert, JDBus, JSONTryParse, serviceSpecifications } from "jacdac-ts"
import {
    BuildReqArgs,
    BuildStatus,
    ConnectReqArgs,
    OutputFrom,
    SideBcastReq,
    SideBuildReq,
    SideBuildResp,
    SideConnectReq,
    SideErrorResp,
    SideEvent,
    SideOutputEvent,
    SideReq,
    SideResp,
    SideSpecsReq,
    SideSpecsResp,
    SideWatchEvent,
    SideWatchReq,
    SideWatchResp,
} from "./sideprotocol"
import pkg from "../package.json"
import { BinFmt, parseImgVersion } from "@devicescript/compiler"

export interface DevToolsIface {
    bus: JDBus
    clients: DevToolsClient[]
    lastOKBuild: BuildStatus

    build: (args: BuildReqArgs) => Promise<BuildStatus>
    watch: (
        args: BuildReqArgs,
        watchCb?: (st: BuildStatus) => void
    ) => Promise<void>

    connect: (req: ConnectReqArgs) => Promise<void>
}

export interface DevToolsClient {
    __devsSender: string
    __devsWantsSideChannel: boolean

    send(data: Buffer | string): void
}

const msgHandlers: Record<
    string,
    (msg: SideReq<string>, sender: DevToolsClient) => Promise<any>
> = {}

export function addReqHandler<
    Req extends SideReq,
    Resp extends SideResp<Req["req"]> = SideResp<Req["req"]>
>(
    req: Req["req"],
    cb: (msg: Req, sender: DevToolsClient) => Promise<Resp["data"]>
) {
    msgHandlers[req] = cb as any
}

let devtools: DevToolsIface

export function initSideProto(devtools_: DevToolsIface) {
    assert(devtools === undefined)
    devtools = devtools_
    addReqHandler<SideBcastReq>("bcast", async (msg, client) => {
        client.__devsWantsSideChannel = msg.data.enabled
    })
    addReqHandler<SideBuildReq, SideBuildResp>("build", async msg => {
        return await devtools.build(msg.data)
    })
    addReqHandler<SideWatchReq, SideWatchResp>("watch", async (msg, client) => {
        return await devtools.watch(msg.data, st =>
            sendEvent<SideWatchEvent>(client, "watch", st)
        )
    })
    addReqHandler<SideConnectReq>("connect", msg => {
        return devtools.connect(msg.data)
    })
    addReqHandler<SideSpecsReq, SideSpecsResp>("specs", async () => {
        const v = parseImgVersion(BinFmt.IMG_VERSION)
        return {
            specs: serviceSpecifications(),
            version: pkg.version,
            runtimeVersion: `v${v.major}.${v.minor}.${v.patch}`,
        }
    })
}

export function sendError(req: SideReq, cl: DevToolsClient, err: any) {
    const info: SideErrorResp = {
        resp: "error",
        seq: req.seq,
        data: {
            message: err.message || "" + err,
            stack: err.stack,
        },
    }
    cl.send(JSON.stringify(info))
}

export function sendEvent<T extends SideEvent>(
    cl: DevToolsClient,
    ev: T["ev"],
    data: T["data"]
) {
    cl.send(
        JSON.stringify({
            ev,
            data,
        })
    )
}

export function sendOutput(
    cl: DevToolsClient,
    from: OutputFrom,
    lines: string[]
) {
    return sendEvent<SideOutputEvent>(cl, "output", {
        from,
        lines,
    })
}

export async function processSideMessage(
    devtools_: DevToolsIface,
    message: string,
    client: DevToolsClient
) {
    const msg: SideReq = JSONTryParse(message)
    if (!msg) return

    assert(devtools === devtools_)

    const handler = msgHandlers[msg.req]
    if (handler) {
        try {
            const data = await handler(msg, client)
            const resp: SideResp = {
                resp: msg.req,
                seq: msg.seq,
                data: data ?? {},
            }
            client.send(JSON.stringify(resp))
        } catch (err) {
            sendError(msg, client, err)
        }
    }

    if (!msg.seq)
        for (const client of devtools.clients) {
            if (client != client && client.__devsWantsSideChannel)
                client.send(message)
        }

    if (msg.seq && !handler)
        sendError(msg, client, new Error(`unknown msg type: ${msg.req}`))
}