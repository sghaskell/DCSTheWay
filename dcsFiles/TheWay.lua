log.write("THEWAY", log.INFO, "Initializing V3.0.0")

local tcpServer                        = nil
local udpSpeaker                       = nil

package.path                           = package.path .. ";" .. lfs.currentdir() .. "/LuaSocket/?.lua"
package.cpath                          = package.cpath .. ";" .. lfs.currentdir() .. "/LuaSocket/?.dll"
package.path                           = package.path .. ";.\\Scripts\\?.lua;.\\Scripts\\UI\\?.lua;.\\dxgui\\loader\\?.lua;.\\dxgui\\bind\\?.lua;.\\dxgui\\skins\\common\\?.lua;.\\dxgui\\skins\\skinME\\?.lua"

local socket                           = require("socket")
local JSON                             = loadfile("Scripts\\JSON.lua")()

local DialogLoader                     = require("DialogLoader")
local dxgui                            = require("dxgui")
local Skin                             = require("Skin")
local SkinUtils                         = require("SkinUtils")

local upstreamLuaExportStart           = LuaExportStart
local upstreamLuaExportAfterNextFrame  = LuaExportAfterNextFrame
local upstreamLuaExportBeforeNextFrame = LuaExportBeforeNextFrame
local upstreamLuaExportStop            = LuaExportStop

local crosshair                        = nil
local statusDialog                     = nil

-- How often the camera/busy state is sent to the app (seconds). The app only
-- reads it every 100 ms, so sending every frame (90+ Hz in VR) was wasted work
-- on the render thread.
local STATE_SEND_INTERVAL              = 0.05
local lastStateSend                    = 0
local lastSentBusy                     = nil

-- In-DCS status text (visible in the VR headset, unlike the desktop app)
local statusHideAt                     = nil -- socket.gettime() deadline, nil = sticky
local statusText                       = ""
local transferAnnounce                 = false
local lastProgressPct                  = -1

-- Partially received TCP clients, so a slow sender never blocks the frame
local pendingClients                   = {}
local PENDING_CLIENT_TIMEOUT           = 2.0

local function setStatusText(text, durationMs)
    if not statusDialog then return end
    local ok, err = pcall(function()
        text = tostring(text or "")
        statusText = text
        if text == "" then
            statusDialog:setVisible(false)
            statusHideAt = nil
            return
        end
        statusDialog.StatusText:setText(text)
        statusDialog:setVisible(true)
        local ms = tonumber(durationMs) or 3000
        if ms > 0 then
            statusHideAt = socket.gettime() + ms / 1000
        else
            statusHideAt = nil
        end
    end)
    if not ok then
        log.write("THEWAY", log.ERROR, "setStatusText failed: " .. tostring(err))
    end
end

local function updateStatusTimeout()
    if statusHideAt and socket.gettime() >= statusHideAt then
        statusHideAt = nil
        setStatusText("", 0)
    end
end

function LuaExportStart()
    if upstreamLuaExportStart ~= nil then
        local successful, err = pcall(upstreamLuaExportStart)
        if not successful then
            log.write("THEWAY", log.ERROR, "Error in upstream LuaExportStart function" .. tostring(err))
        end
    end

    udpSpeaker = socket.udp()
    udpSpeaker:settimeout(0)

    tcpServer = socket.tcp()
    tcpServer:bind("127.0.0.1", 42070)
    -- the app may open several connections at once (e.g. status + waypoints)
    tcpServer:listen(16)
    tcpServer:settimeout(0)

    crosshair = DialogLoader.spawnDialogFromFile(
        lfs.writedir() .. "Scripts\\TheWay\\Crosshair.dlg"
    )

    local skin = crosshair.WaypointCrosshair:getSkin()
    local crosshairPicturePath = lfs.writedir() .. skin.skinData.states.released[1].picture.file
    crosshair.WaypointCrosshair:setSkin(SkinUtils.setStaticPicture(crosshairPicturePath, skin))

    local screenWidth, screenHeigt = dxgui.GetScreenSize()
    local x = screenWidth / 2 - 5
    local y = screenHeigt / 2 - 5
    crosshair:setBounds(math.floor(x), math.floor(y), 10, 10)

    local okStatus, errStatus = pcall(function()
        statusDialog = DialogLoader.spawnDialogFromFile(
            lfs.writedir() .. "Scripts\\TheWay\\TheWayStatus.dlg"
        )
        local w, h = 520, 90
        statusDialog:setBounds(math.floor(screenWidth / 2 - w / 2), math.floor(screenHeigt * 0.18), w, h)
        statusDialog:setVisible(false)
    end)
    if not okStatus then
        statusDialog = nil
        log.write("THEWAY", log.ERROR, "Status dialog unavailable: " .. tostring(errStatus))
    end
end

function LuaExportStop()
    if upstreamLuaExportStop ~= nil then
        local successful, err = pcall(upstreamLuaExportStop)
        if not successful then
            log.write("THEWAY", log.ERROR, "Error in upstream LuaExportStop function" .. tostring(err))
        end
    end

    pcall(function()
        if crosshair and crosshair.setVisible then
            crosshair:setVisible(false)
        end
        if statusDialog and statusDialog.setVisible then
            statusDialog:setVisible(false)
        end
    end)

    -- Release the sockets so the next mission can bind port 42070 again
    for _, pending in ipairs(pendingClients) do
        pcall(function() pending.client:close() end)
    end
    pendingClients = {}
    pcall(function() if tcpServer then tcpServer:close() end end)
    pcall(function() if udpSpeaker then udpSpeaker:close() end end)
    tcpServer = nil
    udpSpeaker = nil
end

local keys                             = nil
local busy                             = false
local isPressed                        = false
local currCommandIndex                 = 1
local lastDevice                       = ""
local lastCode                         = ""
local lastNeedDepress                  = true
local whenToDepress                    = nil
local crosshairVisible                 = false
local stringtoboolean                  = { ["true"] = true, ["false"] = false }

-- ================= Intelligence Snapshot (Unit Import) =================
local function nm_to_m(nm)
    return (tonumber(nm) or 0) * 1852
end

local function safe_json_decode(s)
    local ok, res = pcall(function() return JSON:decode(s) end)
    if ok then return res end
    return nil
end

local function safe_json_encode(t)
    local ok, res = pcall(function() return JSON:encode(t) end)
    if ok then return res end
    return nil
end

-- Generic cockpit-data helpers -----------------------------------------------
local function get_list_indicator_value(indicator_id)
    local list_indicator = list_indication(indicator_id)
    local display_data = {}

    if list_indicator == nil or list_indicator == "" then
        return nil
    end

    local delim = "-----------------------------------------"
    local line_no = 0
    local key = ""
    local val = ""

    for line in list_indicator:gmatch("[^\n]+") do
        if line == delim then
            if key ~= "" then
                display_data[key] = val
            end
            key = ""
            val = ""
            line_no = 0
        end

        if line_no == 1 then
            key = line
        elseif line_no == 2 then
            if line ~= "children are {" and line ~= "}" then
                val = line
            end
        elseif line_no > 2 then
            if line ~= "children are {" and line ~= "}" then
                val = val .. "\n" .. line
            end
        end

        line_no = line_no + 1
    end

    if key ~= "" then
        display_data[key] = val
    end

    return display_data
end

local function send_tcp_response(client, response)
    local encoded = safe_json_encode(response or {})
    if not encoded then
        encoded = '{"ok":false,"error":"JSON encode failed"}'
    end

    local ok, err = pcall(function()
        -- clients are read non-blocking; allow a short, bounded wait to send
        client:settimeout(0.5)
        client:send(encoded .. "\n")
        client:close()
    end)

    if not ok then
        log.write("THEWAY", log.ERROR, "TCP send failed: " .. tostring(err))
    end
end

-- Origin for distance tests in Lo coordinates
local function get_origin_lolo(origin)
    -- Return Lo coordinates {x,z} for distance tests
    if origin == "camera" and LoGetCameraPosition then
        local cam = LoGetCameraPosition()
        if cam and cam.p then
            return { x = cam.p.x, z = cam.p.z }
        end
    end

    local selfData = LoGetSelfData and LoGetSelfData() or nil
    if selfData and selfData.LatLongAlt then
        local ll = selfData.LatLongAlt
        local loLo = LoGeoCoordinatesToLoCoordinates(ll.Long, ll.Lat) -- lon first
        if loLo then
            return { x = loLo.x, z = loLo.z }
        end
    end

    return nil
end

-- Try to fetch unit Lo coordinates without geo conversion
local function get_unit_lolo(unit)
    -- Common shapes: unit.Position, unit.pos, unit.p, unit.Point, unit.point
    local p = unit and (unit.Position or unit.pos or unit.p or unit.Point or unit.point)
    if p and p.x and p.z then
        return { x = tonumber(p.x), z = tonumber(p.z) }
    end
    return nil
end

-- Convert Lo -> Geo only when needed
local function get_unit_geo_from_lolo(lo)
    if not lo or not LoLoCoordinatesToGeoCoordinates then return nil end
    local coords = LoLoCoordinatesToGeoCoordinates(lo.x, lo.z)
    if coords and coords.latitude and coords.longitude then
        return { lat = tonumber(coords.latitude), lon = tonumber(coords.longitude) }
    end
    return nil
end

local function capture_intel_units(params)
    params = params or {}

    -- Normalise the origin string so it matches what the app sends
    local originReq = tostring(params.origin or "camera"):lower()
    if originReq == "camera position" then originReq = "camera" end
    if originReq == "own ship" then originReq = "ownship" end

    local radiusM = nm_to_m(params.radiusNm or 10)

    -- This is what we use for distance filtering
    local center = get_origin_lolo(originReq)

    -- This is what we send back to the app so it can compute bearing/range
    local originOut = nil

    -- If the user chose "camera", use the map camera position
    if originReq == "camera" and LoGetCameraPosition and LoLoCoordinatesToGeoCoordinates then
        local camPos = LoGetCameraPosition()
        if camPos and camPos.p then
            local coords = LoLoCoordinatesToGeoCoordinates(camPos.p.x, camPos.p.z)
            if coords and coords.latitude and coords.longitude then
                originOut = { lat = tonumber(coords.latitude), lon = tonumber(coords.longitude) }
            end
        end
    end

    -- Fallback: ownship (also used when user chose ownship)
    if not originOut then
        local selfData = LoGetSelfData and LoGetSelfData() or nil
        if selfData and selfData.LatLongAlt then
            originOut = {
                lat = tonumber(selfData.LatLongAlt.Lat),
                lon = tonumber(selfData.LatLongAlt.Long)
            }
        end
    end

    if not center then
        log.write("THEWAY", log.ERROR, "INTEL_SNAPSHOT: no origin center for " .. tostring(originReq))
        return {}, originOut
    end

    local units = LoGetWorldObjects and LoGetWorldObjects("units") or nil
    if not units then
        log.write("THEWAY", log.ERROR, "INTEL_SNAPSHOT: LoGetWorldObjects('units') returned nil")
        return {}, originOut
    end

    local out = {}
    local r2 = radiusM * radiusM

    for id, unit in pairs(units) do
        if unit then
            -- 1) Get Lo position cheaply if possible
            local lo = get_unit_lolo(unit)

            -- Fallback: if Lo pos not present, derive from Lat/Lon (more expensive)
            if (not lo) and unit.LatLongAlt then
                local ll = unit.LatLongAlt
                local lat0 = tonumber(ll.Lat)
                local lon0 = tonumber(ll.Long)
                if lat0 and lon0 then
                    local loLo = LoGeoCoordinatesToLoCoordinates(lon0, lat0) -- lon first
                    if loLo then
                        lo = { x = loLo.x, z = loLo.z }
                    end
                end
            end

            if lo then
                -- 2) Radius test using squared distance (no sqrt)
                local dx = lo.x - center.x
                local dz = lo.z - center.z
                local d2 = dx * dx + dz * dz

                if d2 <= r2 then
                    -- 3) Only now resolve geo coords for payload
                    local lat, lon, elevM

                    if unit.LatLongAlt then
                        local ll = unit.LatLongAlt
                        lat = tonumber(ll.Lat)
                        lon = tonumber(ll.Long)
                        elevM = tonumber(ll.Alt) or 0
                    else
                        local geo = get_unit_geo_from_lolo(lo)
                        if geo then
                            lat = geo.lat
                            lon = geo.lon
                        end
                        elevM = tonumber(unit.Alt) or tonumber(unit.alt) or 0
                    end

                    -- If we couldn't resolve lat/lon, skip (app expects them)
                    if lat and lon then
                        -- CoalitionID: 0 = Neutral, 1 = Red, 2 = Blue
                        local coalStr = "Neutral"
                        local coalNum = tonumber(unit.CoalitionID)
                        if coalNum == 1 then
                            coalStr = "Red"
                        elseif coalNum == 2 then
                            coalStr = "Blue"
                        end

                        local t = "UNIT"
                        if type(unit.typeName) == "string" then
                            t = unit.typeName
                        elseif type(unit.Type) == "string" then
                            t = unit.Type
                        elseif type(unit.Name) == "string" then
                            t = unit.Name
                        elseif type(unit.UnitName) == "string" then
                            t = unit.UnitName
                        end

                        local className = unit.Class or unit.class or ""

                        table.insert(out, {
                            id = id,
                            coalition = coalStr,

                            -- keep this as the human readable type string (T-72B3, BMP-2, etc.)
                            type = tostring(t),

                            -- add wsType info for proper classification
                            Type = unit.Type,

                            className = tostring(className),
                            name = tostring(unit.UnitName or unit.Name or ""),
                            lat = lat,
                            lon = lon,
                            elevM = elevM
                        })
                    end
                end
            end
        end
    end

    return out, originOut
end

local function send_intel_snapshot(units, origin)
    if not udpSpeaker then
        log.write("THEWAY", log.ERROR, "INTEL_SNAPSHOT: udpSpeaker is nil")
        return
    end

    units = units or {}

    -- Keep UDP packets comfortably small (way under MTU / fragmentation)
    local MAX_BYTES = 8000

    -- Unique-ish id to group parts on the app side
    local snapId = math.floor(socket.gettime() * 1000)

    -- Send a BEGIN message (small)
    local beginPayload = {
        cmd = "INTEL_SNAPSHOT_BEGIN",
        snapId = snapId,
        origin = origin or nil,
        count = #units
    }
    local beginMsg = safe_json_encode(beginPayload)
    if beginMsg then
        pcall(function()
            socket.try(udpSpeaker:sendto(beginMsg, "127.0.0.1", 42069))
        end)
    end

    -- Build chunks of units
    local chunk = {}
    local idx = 0
    local part = 0

    local function send_chunk()
        if #chunk == 0 then return end
        part = part + 1

        local payload = {
            cmd = "INTEL_SNAPSHOT_PART",
            snapId = snapId,
            part = part,
            units = chunk
        }

        local msg = safe_json_encode(payload)
        if not msg then
            log.write("THEWAY", log.ERROR, "INTEL_SNAPSHOT: JSON encode failed for part " .. tostring(part))
            return
        end

        pcall(function()
            socket.try(udpSpeaker:sendto(msg, "127.0.0.1", 42069))
        end)

        chunk = {}
    end

    -- Conservative sizing: keep adding units until encoding would exceed MAX_BYTES
    for i = 1, #units do
        local u = units[i]
        table.insert(chunk, u)

        local testPayload = {
            cmd = "INTEL_SNAPSHOT_PART",
            snapId = snapId,
            part = part + 1,
            units = chunk
        }
        local testMsg = safe_json_encode(testPayload)

        if not testMsg then
            -- If encoding failed with this unit included, send previous chunk and start fresh
            table.remove(chunk)
            send_chunk()
            chunk = { u }
        elseif #testMsg > MAX_BYTES then
            -- Too big, send previous chunk and start a new one with this unit
            table.remove(chunk)
            send_chunk()
            chunk = { u }
        end
    end

    -- Send final chunk
    send_chunk()

    -- Send DONE message
    local donePayload = {
        cmd = "INTEL_SNAPSHOT_DONE",
        snapId = snapId
    }
    local doneMsg = safe_json_encode(donePayload)
    if doneMsg then
        pcall(function()
            socket.try(udpSpeaker:sendto(doneMsg, "127.0.0.1", 42069))
        end)
    end
end

local function resetKeyQueue()
    keys = nil
    busy = false
    isPressed = false
    currCommandIndex = 1
    lastProgressPct = -1
end

local function clickDevice(deviceId, code, value)
    local device = GetDevice(deviceId)
    if device == nil then
        error("Cockpit device " .. tostring(deviceId) .. " not found (wrong aircraft or seat?)")
    end
    device:performClickableAction(code, value)
end

local function showTransferProgress()
    if not transferAnnounce or not keys or #keys == 0 then return end
    local pct = math.floor(((currCommandIndex - 1) / #keys) * 100)
    -- only touch the widget when the number visibly changes
    if pct ~= lastProgressPct and (pct - lastProgressPct >= 5 or pct < lastProgressPct) then
        lastProgressPct = pct
        setStatusText("TheWay: entering waypoints  " .. pct .. "%", 0)
    end
end

function pressKeys()
    if busy then
        if isPressed then
            -- check if the time has come to depress
            local currTime = socket.gettime()
            if currTime >= whenToDepress then
                -- check if it even needs a depress
                if lastNeedDepress then
                    clickDevice(lastDevice, lastCode, 0)
                end
                isPressed = false
                currCommandIndex = currCommandIndex + 1
            end
        else
            --check if there are buttons left to press
            if keys and currCommandIndex <= #keys then
                lastDevice = keys[currCommandIndex]["device"]
                lastCode = keys[currCommandIndex]["code"]

                lastNeedDepress = stringtoboolean[keys[currCommandIndex]["addDepress"]]

                local delay = tonumber(keys[currCommandIndex]["delay"]) or 0
                local activate = tonumber(keys[currCommandIndex]["activate"]) or 1

                -- Store the depress time before pushing, so a failed push cannot
                -- leave isPressed without a deadline
                whenToDepress = socket.gettime() + (delay / 1000)
                isPressed = true

                -- Push the button
                clickDevice(lastDevice, lastCode, activate)
                showTransferProgress()
            else
                -- if there's nothing else to press, we are done
                local announce = transferAnnounce
                resetKeyQueue()
                transferAnnounce = false
                if announce then
                    setStatusText("TheWay: transfer complete", 3000)
                end
            end
        end
    end
end

local function handleClientMessage(client, data)
    do
        if data then
            local decodedData = safe_json_decode(data)
            if decodedData == nil then
                log.write("THEWAY", log.ERROR, "TCP JSON decode failed: " .. tostring(data))
                send_tcp_response(client, {
                    ok = false,
                    error = "TCP JSON decode failed"
                })
                return
            end

            -- Debug: log what we received (cmd/type)
            if decodedData["cmd"] ~= nil or decodedData["type"] ~= nil then
                log.write("THEWAY", log.INFO, "TCP received cmd=" .. tostring(decodedData["cmd"]) .. " type=" .. tostring(decodedData["type"]))
            end

            -- Generic request / response API
            if decodedData["cmd"] == "GET_PARAM_HANDLES" or
               decodedData["cmd"] == "GET_COCKPIT_DISPLAYS" or
               decodedData["cmd"] == "GET_EXPORT_DATA" or
               decodedData["cmd"] == "GET_OWN_POSITION" then

                local response = {
                    ok = true,
                    HandleData = {},
                    CockpitDisplayData = {},
                    OwnPosition = {},
                    ErrorList = {}
                }

                local handle_names = nil
                local display_ids = nil

                if decodedData["cmd"] == "GET_EXPORT_DATA" then
                    handle_names = decodedData["handles"] or decodedData["GetHandleData"]
                    display_ids = decodedData["displays"] or decodedData["GetCockpitDisplayData"]
                elseif decodedData["cmd"] == "GET_PARAM_HANDLES" then
                    handle_names = decodedData["handles"] or decodedData["GetHandleData"]
                elseif decodedData["cmd"] == "GET_COCKPIT_DISPLAYS" then
                    display_ids = decodedData["displays"] or decodedData["GetCockpitDisplayData"]
                elseif decodedData["cmd"] == "GET_OWN_POSITION" then
                    local ok_pos, err_pos = pcall(function()
                        local selfData = LoGetSelfData and LoGetSelfData() or nil
                        if selfData and selfData.LatLongAlt then
                            response["OwnPosition"]["lat"] = tostring(selfData.LatLongAlt.Lat)
                            response["OwnPosition"]["long"] = tostring(selfData.LatLongAlt.Long)
                            response["OwnPosition"]["alt"] = tostring(selfData.LatLongAlt.Alt or 0)
                            response["OwnPosition"]["model"] = tostring(selfData.Name or "Unknown")
                        else
                            response["ok"] = false
                            table.insert(response["ErrorList"], "LoGetSelfData().LatLongAlt unavailable")
                        end
                    end)

                    if not ok_pos then
                        response["ok"] = false
                        table.insert(response["ErrorList"], tostring(err_pos))
                        log.write("THEWAY", log.ERROR, "Failure to get own position: " .. tostring(err_pos))
                    end
                end

                if handle_names then
                    local ok_handles, err_handles = pcall(function()
                        for _, handle_name in pairs(handle_names) do
                            local handle = get_param_handle(handle_name)
                            if handle then
                                response["HandleData"][handle_name] = tostring(handle:get())
                            else
                                response["HandleData"][handle_name] = nil
                            end
                        end
                    end)

                    if not ok_handles then
                        response["ok"] = false
                        table.insert(response["ErrorList"], tostring(err_handles))
                        log.write("THEWAY", log.ERROR, "Failure to get handle data: " .. tostring(err_handles))
                    end
                end

                if display_ids then
                    local ok_displays, err_displays = pcall(function()
                        for _, display_id in pairs(display_ids) do
                            local display_data = get_list_indicator_value(display_id)
                            if display_data then
                                response["CockpitDisplayData"][tostring(display_id)] = display_data
                            end
                        end
                    end)

                    if not ok_displays then
                        response["ok"] = false
                        table.insert(response["ErrorList"], tostring(err_displays))
                        log.write("THEWAY", log.ERROR, "Failure to get cockpit display data: " .. tostring(err_displays))
                    end
                end

                send_tcp_response(client, response)
                return
            end

            -- Intelligence snapshot request: accept both formats
            if decodedData["cmd"] == "INTEL_SNAPSHOT" or decodedData["type"] == "intel_snapshot" then
                local p = decodedData
                if decodedData["payload"] and type(decodedData["payload"]) == "table" then
                    p = decodedData["payload"]
                end
                local units, origin = capture_intel_units(p)
                send_intel_snapshot(units, origin)

            elseif decodedData["type"] == "waypoints" then
                resetKeyQueue()
                keys = decodedData["payload"]
                busy = type(keys) == "table" and #keys > 0
                if not busy then keys = nil end
                transferAnnounce = busy and decodedData["announce"] == true

            elseif decodedData["type"] == "status" then
                local p = decodedData["payload"]
                if type(p) == "table" then
                    if p["onlyIf"] == nil or p["onlyIf"] == statusText then
                        setStatusText(p["text"], p["ms"])
                    end
                else
                    setStatusText(p, 3000)
                end

            elseif decodedData["type"] == "crosshair" then
                local shouldBeVisible = stringtoboolean[decodedData["payload"]]
                if crosshair and crosshair.setVisible then
                    crosshair:setVisible(shouldBeVisible)
                else
                    log.write("THEWAY", log.ERROR, "Crosshair dialog not available (crosshair is nil)")
                end

            elseif decodedData["type"] == "abort" then
                local wasBusy = busy
                resetKeyQueue()
                transferAnnounce = false
                if wasBusy then
                    setStatusText("TheWay: transfer aborted", 3000)
                end
            end
        end

        pcall(function()
            client:close()
        end)
    end
end

-- Accept new connections and read from them without ever blocking the frame.
-- A message that has not fully arrived yet is kept and retried next frame.
function checkSocket()
    if not tcpServer then return end

    -- accept every connection that is waiting, not just one per frame
    for _ = 1, 16 do
        local client = tcpServer:accept()
        if client == nil then break end
        client:settimeout(0)
        table.insert(pendingClients, { client = client, buffer = "", started = socket.gettime() })
    end

    -- oldest first, so messages are handled in the order they were sent
    local now = socket.gettime()
    local i = 1
    while i <= #pendingClients do
        local pending = pendingClients[i]
        local line, err, partial = pending.client:receive("*l")
        if line then
            table.remove(pendingClients, i)
            handleClientMessage(pending.client, pending.buffer .. line)
        else
            if partial and partial ~= "" then
                pending.buffer = pending.buffer .. partial
            end
            if err ~= "timeout" or now - pending.started > PENDING_CLIENT_TIMEOUT then
                if err ~= "timeout" and err ~= "closed" then
                    log.write("THEWAY", log.ERROR, "Error at receiving: " .. tostring(err))
                end
                table.remove(pendingClients, i)
                -- a sender that closed without a newline still delivered its message
                if pending.buffer ~= "" then
                    handleClientMessage(pending.client, pending.buffer)
                else
                    pcall(function() pending.client:close() end)
                end
            else
                i = i + 1 -- still waiting for the rest of this message
            end
        end
    end
end

function LuaExportBeforeNextFrame()
    if upstreamLuaExportBeforeNextFrame ~= nil then
        local successful, err = pcall(upstreamLuaExportBeforeNextFrame)
        if not successful then
            log.write("THEWAY", log.ERROR, "Error in upstream LuaExportBeforeNextFrame function" .. tostring(err))
        end
    end

    -- Each step is protected separately: an error in one (e.g. a missing cockpit
    -- device) must not stop the socket from being serviced every frame after.
    local okKeys, errKeys = pcall(pressKeys)
    if not okKeys then
        log.write("THEWAY", log.ERROR, "pressKeys failed, transfer stopped: " .. tostring(errKeys))
        resetKeyQueue()
        transferAnnounce = false
        setStatusText("TheWay: transfer failed - see dcs.log", 5000)
    end

    local okSocket, errSocket = pcall(checkSocket)
    if not okSocket then
        log.write("THEWAY", log.ERROR, "checkSocket failed: " .. tostring(errSocket))
    end

    pcall(updateStatusTimeout)
end

function LuaExportAfterNextFrame()
    if upstreamLuaExportAfterNextFrame ~= nil then
        local successful, err = pcall(upstreamLuaExportAfterNextFrame)
        if not successful then
            log.write("THEWAY", log.ERROR, "Error in upstream LuaExportAfterNextFrame function" .. tostring(err))
        end
    end

    -- Throttle: send at most every STATE_SEND_INTERVAL, but always send at
    -- once when busy changes so transfer code sees every busy edge.
    local now = socket.gettime()
    if busy == lastSentBusy and (now - lastStateSend) < STATE_SEND_INTERVAL then
        return
    end

    local ok, err = pcall(function()
        if not udpSpeaker then return end

        local camPos = LoGetCameraPosition()
        if not camPos or not camPos.p then return end
        local loX = camPos['p']['x']
        local loZ = camPos['p']['z']
        local elevation = LoGetAltitude(loX, loZ)
        local coords = LoLoCoordinatesToGeoCoordinates(loX, loZ)
        if not coords then return end

        local selfData = LoGetSelfData()
        local model = selfData and selfData['Name'] or 'Spectator'

        local message = {}
        message["model"] = model
        message["coords"] = {}
        message["coords"]["lat"] = tostring(coords.latitude)
        message["coords"]["long"] = tostring(coords.longitude)
        message["elev"] = tostring(elevation)
        message["busy"] = busy

        socket.try(udpSpeaker:sendto(JSON:encode(message), "127.0.0.1", 42069))
        lastStateSend = now
        lastSentBusy = busy
    end)

    if not ok then
        log.write("THEWAY", log.ERROR, "Unable to send data: " .. tostring(err))
        lastStateSend = now -- don't retry (and log) every frame
    end
end

log.write("THEWAY", log.INFO, "Done")