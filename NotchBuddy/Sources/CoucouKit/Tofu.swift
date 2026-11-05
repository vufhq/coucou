import SwiftUI

// Tofu — a flat pebble that moves exactly like Mochi. The Mac port of
// windows/src/mochi/tofu.ts, character.ts and tofu-shape.ts.
//
// BotEngine keeps every tween, spring, particle and outfit transition; when the
// character is Tofu its draw() hands the body, eyes, hands and outfit to
// TofuRenderer. The badge, the mood extras and the particles stay the engine's.
//
// Tofu's look: grok-bot-avatar-engine's pebble and eye seat (TofuShape below),
// one flat colour, flat eyes with no highlight. Mochi's life on top: the eyes
// are projected on an ellipsoid the size of the pebble, the state tint and the
// cheeks paint over the body, and the hands come out only to wave.
//
// Tofu's outfits are Mochi's twelve, redrawn as flat parts on anchors (crown,
// brim, side, eyes, neck, body…) projected on the head like the outfits are
// (view tilted −0.3, 40 % of the pitch). They enter and leave on the engine's
// presence tween with Mochi's four transitions: drop, slide, pop and fade.
//
// Coordinates here are Tofu units: origin at the centre of the pebble, y down,
// the pebble 1.8 wide. One unit is UNIT × the engine's R, so the pebble is
// exactly as tall as Mochi (2 × 0.88 R) and sits where he does.

// MARK: - Which character

/// Which character Coucou draws: Mochi (the default, as shipped) or Tofu.
/// Picked in Settings → General, stored as `character` and `tofuColor`
/// (the Windows app's names). Read on every frame, so a change shows at once.
enum MochiCharacter: String, CaseIterable, Sendable {
    case mochi, tofu

    static let defaultsKey = "character"
    static let colorKey = "tofuColor"

    /// Anything unknown (a newer build's value, garbage) means Mochi.
    static func parse(_ raw: Any?) -> MochiCharacter {
        (raw as? String) == "tofu" ? .tofu : .mochi
    }

    static var current: MochiCharacter {
        parse(UserDefaults.standard.object(forKey: defaultsKey))
    }
}

/// Tofu's palette, in grok-bot-avatar-engine's order.
enum TofuColor: String, CaseIterable, Sendable {
    case brown, red, orange, yellow, green, cyan, blue, violet, magenta, gray

    /// The colour the library's ID recipe gives "mochi".
    static let `default`: TofuColor = .brown

    static func parse(_ raw: Any?) -> TofuColor {
        (raw as? String).flatMap(TofuColor.init(rawValue:)) ?? .default
    }

    static var current: TofuColor {
        parse(UserDefaults.standard.object(forKey: MochiCharacter.colorKey))
    }

    /// The ink on a light background.
    var light: String {
        switch self {
        case .brown: "#A27952"
        case .red: "#FF3E51"
        case .orange: "#FF781C"
        case .yellow: "#FFAF38"
        case .green: "#00C972"
        case .cyan: "#1CC3B0"
        case .blue: "#2A92FE"
        case .violet: "#A97EFE"
        case .magenta: "#FF5EB1"
        case .gray: "#959595"
        }
    }

    /// The ink on a dark background: Coucou's island is always dark.
    var dark: String {
        switch self {
        case .brown: "#855C36"
        case .red: "#E02135"
        case .orange: "#FF6700"
        case .yellow: "#FF9800"
        case .green: "#009957"
        case .cyan: "#00A592"
        case .blue: "#0E74E0"
        case .violet: "#804EE0"
        case .magenta: "#E02A88"
        case .gray: "#777777"
        }
    }
}

// MARK: - The pebble (grok-bot-avatar-engine)

// Tofu's shape, from grok-bot-avatar-engine 5b6fc03
// (https://github.com/RongleCat/grok-bot-avatar-engine): the pebble outline and
// its eye seat (src/geometry.mjs, eyes.mjs). Same data as windows/src/mochi/tofu-shape.ts.
//
// MIT License
//
// Copyright (c) 2026 RongleCat
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
enum TofuShape {
    /// The pebble, in the library's 0…230 viewBox units (y down).
    static let d = [
        "M228.11 115.24C228.26 117.02 228.36 118.81 228.42 120.6C228.49 122.4 228.51 124.19 228.48 126",
        "C228.46 127.8 228.39 129.6 228.27 131.41C228.16 133.22 228 135.02 227.78 136.83",
        "C227.58 138.64 227.32 140.45 227.01 142.24C226.71 144.04 226.34 145.84 225.93 147.62",
        "C225.53 149.41 225.07 151.19 224.56 152.95C224.05 154.72 223.49 156.47 222.87 158.21",
        "C222.26 159.95 221.59 161.67 220.87 163.38C220.15 165.08 219.38 166.77 218.56 168.43",
        "C217.72 170.09 216.85 171.73 215.92 173.34C214.99 174.95 214.01 176.53 212.98 178.08",
        "C211.95 179.63 210.87 181.15 209.73 182.63C208.61 184.12 207.43 185.57 206.2 186.98",
        "C204.98 188.38 203.71 189.75 202.39 191.08C201.08 192.41 199.72 193.69 198.33 194.93",
        "C196.93 196.17 195.49 197.36 194.02 198.51C192.55 199.65 191.04 200.75 189.5 201.8",
        "C187.96 202.84 186.38 203.84 184.78 204.78C183.18 205.73 181.54 206.62 179.9 207.46",
        "C178.24 208.31 176.56 209.1 174.86 209.84C173.17 210.57 171.45 211.25 169.73 211.89",
        "C167.99 212.52 166.25 213.1 164.5 213.63C162.74 214.15 160.98 214.63 159.2 215.06",
        "C157.43 215.48 155.65 215.86 153.87 216.18C152.08 216.52 150.3 216.79 148.52 217.03",
        "C146.74 217.26 144.95 217.45 143.17 217.59C141.4 217.75 139.62 217.85 137.85 217.91",
        "C136.09 217.97 134.32 217.99 132.56 217.98C130.81 217.96 129.06 217.91 127.33 217.82",
        "C125.58 217.74 123.85 217.61 122.14 217.46C120.42 217.31 118.71 217.12 117.01 216.91",
        "C115.32 216.7 113.63 216.46 111.96 216.18C110.27 215.92 108.61 215.63 106.95 215.31",
        "C105.3 215 103.65 214.65 102.02 214.29C100.38 213.92 98.76 213.53 97.15 213.13",
        "C95.52 212.72 93.92 212.3 92.32 211.85C90.72 211.4 89.13 210.94 87.54 210.45",
        "C85.96 209.96 84.38 209.45 82.8 208.93C81.24 208.4 79.67 207.85 78.11 207.29",
        "C76.55 206.72 75 206.13 73.44 205.52C71.89 204.92 70.35 204.29 68.8 203.63",
        "C67.26 202.98 65.73 202.3 64.2 201.6C62.66 200.9 61.14 200.16 59.63 199.41",
        "C58.11 198.66 56.59 197.88 55.09 197.07C53.58 196.26 52.09 195.42 50.59 194.55",
        "C49.1 193.69 47.62 192.78 46.16 191.85C44.7 190.92 43.23 189.95 41.79 188.96",
        "C40.35 187.95 38.92 186.92 37.52 185.85C36.11 184.78 34.72 183.67 33.35 182.53",
        "C31.99 181.39 30.64 180.2 29.32 178.98C28 177.76 26.7 176.5 25.44 175.2",
        "C24.17 173.91 22.93 172.57 21.73 171.2C20.54 169.83 19.37 168.42 18.25 166.97",
        "C17.12 165.53 16.04 164.05 14.99 162.52C13.96 161.01 12.95 159.45 12.01 157.86",
        "C11.05 156.28 10.15 154.66 9.3 153.01C8.46 151.36 7.65 149.68 6.91 147.97",
        "C6.17 146.26 5.48 144.53 4.85 142.77C4.22 141.01 3.64 139.24 3.14 137.44",
        "C2.63 135.64 2.18 133.82 1.8 131.99C1.41 130.16 1.09 128.3 0.83 126.46",
        "C0.57 124.6 0.38 122.73 0.24 120.86C0.12 119 0.05 117.12 0.05 115.24",
        "C0.05 113.36 0.12 111.48 0.24 109.62C0.38 107.75 0.57 105.88 0.82 104.02",
        "C1.08 102.18 1.39 100.32 1.78 98.49C2.15 96.65 2.59 94.84 3.09 93.03",
        "C3.58 91.23 4.14 89.45 4.75 87.68C5.36 85.92 6.02 84.18 6.74 82.46C7.45 80.74 8.22 79.04 9.03 77.38",
        "C9.86 75.71 10.72 74.08 11.63 72.46C12.54 70.85 13.49 69.27 14.49 67.72",
        "C15.48 66.17 16.52 64.65 17.58 63.15C18.66 61.67 19.76 60.21 20.91 58.79",
        "C22.05 57.37 23.23 55.98 24.43 54.62C25.63 53.26 26.87 51.94 28.13 50.64",
        "C29.39 49.35 30.68 48.09 31.99 46.86C33.31 45.63 34.64 44.44 36 43.28",
        "C37.35 42.11 38.73 40.98 40.12 39.89C41.52 38.79 42.93 37.72 44.36 36.68",
        "C45.79 35.64 47.24 34.64 48.71 33.66C50.17 32.69 51.64 31.75 53.13 30.83",
        "C54.62 29.92 56.14 29.03 57.65 28.17C59.17 27.32 60.7 26.49 62.25 25.7",
        "C63.79 24.89 65.34 24.12 66.92 23.38C68.48 22.64 70.06 21.93 71.66 21.25",
        "C73.24 20.57 74.84 19.92 76.46 19.29C78.07 18.67 79.7 18.08 81.33 17.51",
        "C82.97 16.96 84.62 16.43 86.27 15.93C87.93 15.42 89.59 14.96 91.27 14.52",
        "C92.94 14.09 94.63 13.69 96.32 13.32C98.02 12.96 99.73 12.62 101.43 12.32",
        "C103.15 12.02 104.86 11.76 106.59 11.54C108.31 11.31 110.05 11.12 111.78 10.98",
        "C113.52 10.82 115.27 10.71 117.01 10.64C118.76 10.58 120.51 10.55 122.26 10.56",
        "C124.01 10.57 125.76 10.63 127.52 10.72C129.27 10.82 131.02 10.97 132.77 11.15",
        "C134.51 11.33 136.26 11.57 138.01 11.83C139.74 12.1 141.48 12.43 143.2 12.78",
        "C144.93 13.15 146.64 13.56 148.35 14.01C150.05 14.46 151.75 14.96 153.42 15.49",
        "C155.11 16.04 156.77 16.63 158.43 17.26C160.07 17.89 161.71 18.56 163.32 19.28",
        "C164.94 19.99 166.54 20.75 168.11 21.55C169.68 22.36 171.24 23.21 172.76 24.09",
        "C174.29 24.98 175.8 25.9 177.27 26.85C178.75 27.82 180.2 28.82 181.62 29.86",
        "C183.06 30.89 184.46 31.97 185.82 33.08C187.19 34.18 188.53 35.33 189.84 36.5",
        "C191.15 37.67 192.43 38.88 193.67 40.11C194.92 41.35 196.14 42.62 197.32 43.91",
        "C198.51 45.21 199.65 46.53 200.78 47.87C201.9 49.22 202.98 50.59 204.04 51.99",
        "C205.09 53.38 206.12 54.8 207.1 56.24C208.1 57.68 209.05 59.15 209.98 60.64",
        "C210.9 62.12 211.79 63.62 212.65 65.14C213.51 66.67 214.33 68.21 215.12 69.76",
        "C215.92 71.33 216.68 72.9 217.4 74.49C218.13 76.08 218.82 77.69 219.48 79.31",
        "C220.14 80.93 220.76 82.57 221.35 84.22C221.95 85.87 222.49 87.54 223.02 89.22",
        "C223.54 90.9 224.03 92.59 224.48 94.29C224.93 95.99 225.35 97.71 225.72 99.43",
        "C226.11 101.16 226.45 102.91 226.76 104.65C227.06 106.4 227.33 108.15 227.55 109.92",
        "C227.77 111.69 227.97 113.46 228.11 115.24Z",
    ].joined()
    /// Bounding box: x, y, width, height.
    static let box: (x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat) = (0.05, 10.56, 228.44, 207.42)
    /// Width of the head just below its top, where a hat sits.
    static let hatW: CGFloat = 163.34
    /// Eye seat, as fractions of the shape's span: size, gap between centres, lift above the middle.
    static let seat: (width: CGFloat, height: CGFloat, gap: CGFloat, shiftY: CGFloat) = (0.1472, 0.2576, 0.2902, 0.12)
}

// MARK: - A small SVG path reader (M L C Q Z, absolute), enough for the pebble and the costumes

enum TofuSVG {
    /// Every number in `d`, in order (the costumes' hat fitting reads them too).
    static func numbers(_ d: String) -> [CGFloat] {
        var out: [CGFloat] = []
        var current = ""
        func flush() {
            if let v = Double(current) { out.append(CGFloat(v)) }
            current = ""
        }
        for ch in d {
            if ch.isNumber || ch == "." {
                // A second dot starts a new number ("0.5.5").
                if ch == ".", current.contains(".") { flush() }
                current.append(ch)
            } else if ch == "-" {
                flush()
                current = "-"
            } else {
                flush()
            }
        }
        flush()
        return out
    }

    static func path(_ d: String) -> Path {
        var path = Path()
        var command: Character = "M"
        var args: [CGFloat] = []
        func run() {
            switch command {
            case "M":
                var i = 0
                while i + 1 < args.count {
                    let p = CGPoint(x: args[i], y: args[i + 1])
                    if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
                    i += 2
                }
            case "L":
                var i = 0
                while i + 1 < args.count { path.addLine(to: CGPoint(x: args[i], y: args[i + 1])); i += 2 }
            case "C":
                var i = 0
                while i + 5 < args.count {
                    path.addCurve(to: CGPoint(x: args[i + 4], y: args[i + 5]),
                                  control1: CGPoint(x: args[i], y: args[i + 1]),
                                  control2: CGPoint(x: args[i + 2], y: args[i + 3]))
                    i += 6
                }
            case "Q":
                var i = 0
                while i + 3 < args.count {
                    path.addQuadCurve(to: CGPoint(x: args[i + 2], y: args[i + 3]),
                                      control: CGPoint(x: args[i], y: args[i + 1]))
                    i += 4
                }
            case "Z":
                path.closeSubpath()
            default:
                break
            }
            args = []
        }
        var segment = ""
        for ch in d {
            if "MLCQZ".contains(ch) {
                args = numbers(segment)
                run()
                command = ch
                segment = ""
            } else {
                segment.append(ch)
            }
        }
        args = numbers(segment)
        run()
        return path
    }
}

// MARK: - What the engine hands over

struct TofuPose {
    var yaw: CGFloat = 0
    var pitch: CGFloat = 0
    var roll: CGFloat = 0
    /// Dressed, the whole character rolls: the eyes must not roll again.
    var rigidRoll = false
    var tilt: CGFloat = 0
    var sx: CGFloat = 1
    var sy: CGFloat = 1
    var es: CGFloat = 1
    var blush: CGFloat = 0
    var tint: CGFloat = 0
    var hands: CGFloat = 0
    var morph: CGFloat = 0
    var col: (CGFloat, CGFloat, CGFloat) = (0, 0, 0)
    var state: BotState = .idle
    var eye: EyeShape = .pill
    var outfit: Outfit = .none
    /// 0 = gone, 1 = fully on (the engine's outfitPresence).
    var presence: CGFloat = 0
    var physDx: CGFloat = 0
    var physDy: CGFloat = 0
    var waveStart: Double = 0
    var waveUntil: Double = 0
    var isMini = false
    /// The body colour.
    var fill: Color = Color(hex: TofuColor.default.dark)
}

struct TofuHooks {
    /// The engine's eye shapes: Tofu's eyes are Mochi's thirteen.
    var eye: (inout GraphicsContext, EyeShape, CGFloat, CGFloat, CGFloat) -> Void
    /// The mailbox slot, `body` in the engine's pixels around the centre.
    var mouth: ((inout GraphicsContext, Path) -> Void)? = nil
    /// Anything painted over the body in the engine's pixels (the Mac's mood tint), clipped to it.
    var overBody: ((inout GraphicsContext, Path, CGFloat, CGFloat) -> Void)? = nil
}

// MARK: - Renderer

enum TofuRenderer {
    /// The pebble's longest side, in Tofu units.
    static let span: CGFloat = 1.8
    static let k: CGFloat = span / max(TofuShape.box.w, TofuShape.box.h)
    /// Engine R → Tofu units: the pebble is as tall as Mochi.
    static let unit: CGFloat = (2 * 0.88) / (TofuShape.box.h * k)

    /// Mini Tofus (pills, HQ) get bigger eyes, like mini Mochis.
    static let miniEyes: CGFloat = 1.35
    static let viewTilt: CGFloat = -0.3
    static let accPitch: CGFloat = 0.4

    struct Geometry {
        var path: Path
        var halfW: CGFloat
        var halfH: CGFloat
        var top: CGFloat
        var eye: (w: CGFloat, h: CGFloat, gap: CGFloat, y: CGFloat)
        var face: (rx: CGFloat, ry: CGFloat)
        /// Mochi's eyeSp and eyeP for the pebble.
        var eyeSp: CGFloat
        var eyeP: CGFloat
        /// The head outfits are projected on: its crown lands on the top of the pebble.
        var head: (rx: CGFloat, ry: CGFloat)
        /// Hats scale with the head's width just below the top, so the brim covers it.
        var hatScale: CGFloat
        /// Glasses: sized for an eye of 0.2 × 0.23 and eyes 0.71 apart.
        var lens: CGFloat
    }

    static let geo: Geometry = {
        let b = TofuShape.box
        let t = CGAffineTransform(a: k, b: 0, c: 0, d: k, tx: -(b.x + b.w / 2) * k, ty: -(b.y + b.h / 2) * k)
        let path = TofuSVG.path(TofuShape.d).applying(t)
        let halfW = (b.w * k) / 2
        let halfH = (b.h * k) / 2
        let top = -halfH
        let s = TofuShape.seat
        let eye = (w: s.width * span, h: s.height * span, gap: s.gap * span, y: -s.shiftY * span)
        let face = (rx: halfW * 0.96, ry: halfH * 0.96)
        func clamp(_ v: CGFloat) -> CGFloat { max(-0.95, min(0.95, v)) }
        return Geometry(
            path: path, halfW: halfW, halfH: halfH, top: top, eye: eye, face: face,
            eyeSp: asin(clamp(eye.gap / 2 / face.rx)),
            eyeP: asin(clamp(-eye.y / face.ry)),
            head: (rx: max(halfW, 0.5), ry: max(0.3, -(top + 0.04) / (0.97 * cos(0.3)))),
            hatScale: max(0.6, min(1.45, (TofuShape.hatW * k) / 1.39)),
            lens: min(max(eye.w / 0.2, (eye.h / 0.23) * 0.8), eye.gap / 2 / 0.19)
        )
    }()

    // MARK: Projection and anchors

    struct Look {
        var yaw: CGFloat, pitch: CGFloat, roll: CGFloat, rigidRoll: Bool
        static let rest = Look(yaw: 0, pitch: 0, roll: 0, rigidRoll: false)
    }

    struct FacePoint { var visible: Bool; var x: CGFloat; var y: CGFloat; var fx: CGFloat; var fy: CGFloat }

    /// A point on the face ellipsoid (Mochi's eye projection), with foreshortening.
    static func facePoint(_ g: Geometry, _ l: Look, yawOff: CGFloat, pitchOff: CGFloat, withRoll: Bool) -> FacePoint {
        let yw = yawOff + l.yaw
        var pt = pitchOff + l.pitch + (withRoll && !l.rigidRoll ? l.roll : 0)
        let tau = CGFloat.pi * 2
        pt = (((pt + .pi).truncatingRemainder(dividingBy: tau)) + tau).truncatingRemainder(dividingBy: tau) - .pi
        let cp = cos(pt)
        return FacePoint(
            visible: cos(yw) * cp > 0.04,
            x: sin(yw) * cp * g.face.rx,
            y: -sin(pt) * g.face.ry,
            fx: max(0.18, cos(yw)),
            fy: max(0.18, cp)
        )
    }

    /// Head-local point (x right, y up, z toward the viewer), projected like Mochi's outfits.
    static func headProj(_ g: Geometry, _ l: Look, _ x: CGFloat, _ y: CGFloat, _ z: CGFloat) -> CGPoint {
        let cy = cos(l.yaw), sy = sin(l.yaw)
        let x1 = x * cy + z * sy
        let z1 = -x * sy + z * cy
        let pitch = viewTilt + l.pitch * accPitch
        let cp = cos(pitch), sp = sin(pitch)
        return CGPoint(x: x1 * g.head.rx, y: -(y * cp + z1 * sp) * g.head.ry)
    }

    enum Anchor { case crown, brim, side, eyeL, eyeR, eyes, neck, body }

    struct Frame { var x: CGFloat; var y: CGFloat; var fx: CGFloat; var fy: CGFloat; var rot: CGFloat }

    static func anchorFrame(_ g: Geometry, _ l: Look, _ name: Anchor) -> Frame {
        switch name {
        case .crown, .brim:
            let p = headProj(g, l, 0, name == .crown ? 0.97 : 0.7, 0)
            return Frame(x: p.x + sin(l.yaw) * 0.1, y: p.y, fx: 1, fy: 1, rot: l.yaw * 0.15)
        case .side:
            let ring = sqrt(1 - 0.86 * 0.86)
            let p = headProj(g, l, ring * sin(0.55), 0.86, ring * cos(0.55))
            return Frame(x: p.x, y: p.y, fx: max(0.45, cos(0.55 + l.yaw)), fy: 1, rot: 0.35 + l.yaw * 0.3)
        case .eyeL, .eyeR:
            let f = facePoint(g, l, yawOff: (name == .eyeL ? -1 : 1) * g.eyeSp, pitchOff: g.eyeP, withRoll: false)
            return Frame(x: f.x, y: f.y, fx: f.fx * g.lens, fy: f.fy * max(g.lens, (g.eye.h / 0.23) * 0.85), rot: 0)
        case .eyes:
            let f = facePoint(g, l, yawOff: 0, pitchOff: g.eyeP, withRoll: false)
            return Frame(x: f.x, y: f.y, fx: (f.fx * g.eye.gap) / 0.71, fy: g.lens, rot: 0)
        case .neck:
            return Frame(x: sin(l.yaw) * g.halfW * 0.3, y: g.halfH * 0.55, fx: g.halfW, fy: 1, rot: 0)
        case .body:
            return Frame(x: 0, y: 0, fx: g.halfW, fy: g.halfH / 0.82, rot: 0)
        }
    }

    // MARK: Costumes: Mochi's twelve, as flat parts

    /// A colour, or a linear gradient in the part's own space.
    enum Paint {
        case color(String)
        case gradient(from: CGPoint, to: CGPoint, stops: [(CGFloat, String)])
    }

    enum Shape { case ellipse, circle, rect, halfEllipse, poly, line, path }

    enum Enter { case drop, slide, pop, fade }

    struct React { var state: BotState; var glow: Bool; var color: String? = nil }

    struct Part {
        var shape: Shape
        var anchor: Anchor = .crown
        var behind = false
        var x: CGFloat = 0
        var y: CGFloat = 0
        var w: CGFloat = 0
        var h: CGFloat = 0
        var r: CGFloat = 0
        var rot: CGFloat = 0
        var points: [CGPoint] = []
        var d: String? = nil
        var fill: Paint? = nil
        var stroke: Paint? = nil
        var lw: CGFloat = 0.03
        /// Mochi's sheen across [left, right]: light, clear, then shade.
        var shine: (CGFloat, CGFloat)? = nil
        /// halfEllipse: the arc alone, not closed.
        var open = false
        /// Follows the soft-part spring.
        var spring: CGFloat = 0
        var clipBody = false
        var react: React? = nil

        var isHat: Bool { anchor == .crown || anchor == .brim || anchor == .side }
    }

    struct Costume {
        var enter: Enter
        /// Where a dropped hat rests on the head (else 0.1 above its lowest point).
        var seat: (anchor: Anchor, y: CGFloat)? = nil
        /// Recolours the body, like Mochi's pumpkin.
        var body: (String, String)? = nil
        var parts: [Part]
    }

    private static func pts(_ p: [(CGFloat, CGFloat)]) -> [CGPoint] { p.map { CGPoint(x: $0.0, y: $0.1) } }
    private static func grad(_ from: (CGFloat, CGFloat), _ to: (CGFloat, CGFloat), _ stops: [(CGFloat, String)]) -> Paint {
        .gradient(from: CGPoint(x: from.0, y: from.1), to: CGPoint(x: to.0, y: to.1), stops: stops)
    }
    private static let white: Paint = .color("#FFFFFF")

    static func costume(_ outfit: Outfit) -> Costume? {
        switch outfit {
        case .none, .auto: return nil
        case .partyHat: return Costume(enter: .drop, parts: [
            Part(shape: .poly, points: pts([(-0.38, 0.06), (0.38, 0.06), (0.04, -0.95)]),
                 fill: grad((-0.38, -0.95), (0.38, 0.06), [(0, "#FF9BD0"), (0.5, "#F15BAE"), (1, "#C2187A")]), shine: (-0.38, 0.38)),
            Part(shape: .circle, x: -0.12, y: -0.14, r: 0.05, fill: white),
            Part(shape: .circle, x: 0.12, y: -0.3, r: 0.045, fill: white),
            Part(shape: .circle, x: -0.02, y: -0.55, r: 0.04, fill: white),
            Part(shape: .line, points: pts([(-0.37, 0.06), (0.37, 0.06)]), stroke: .color("#FFD84D"), lw: 0.07),
            Part(shape: .circle, x: 0.04, y: -0.99, r: 0.13, fill: .color("#FFE27A"), stroke: .color("#F2B705"), lw: 0.02,
                 spring: 1, react: React(state: .finished, glow: false)),
        ])
        case .beanie: return Costume(enter: .drop, parts: [
            Part(shape: .halfEllipse, y: 0.22, w: 1.5, h: 0.46, fill: grad((0.5, -0.46), (-0.6, 0), [(0, "#7DB6FF"), (1, "#2F6FE0")]), shine: (-0.75, 0.75)),
            Part(shape: .line, points: pts([(-0.36, -0.12), (-0.42, 0.2)]), stroke: .color("rgba(20,50,140,0.22)"), lw: 0.045),
            Part(shape: .line, points: pts([(0, -0.2), (0, 0.2)]), stroke: .color("rgba(20,50,140,0.22)"), lw: 0.045),
            Part(shape: .line, points: pts([(0.36, -0.12), (0.42, 0.2)]), stroke: .color("rgba(20,50,140,0.22)"), lw: 0.045),
            Part(shape: .rect, y: 0.22, w: 1.58, h: 0.22, r: 0.1, fill: grad((0, -0.11), (0, 0.11), [(0, "#3C7BEA"), (1, "#2257C4")])),
            Part(shape: .circle, y: -0.3, r: 0.15, fill: white, stroke: .color("#D5D9E2"), lw: 0.025, spring: 1),
        ])
        case .crown: return Costume(enter: .drop, parts: [
            Part(shape: .poly, behind: true, y: -0.06,
                 points: pts([(-0.34, 0.04), (0.34, 0.04), (0.36, -0.34), (0.18, -0.16), (0, -0.4), (-0.18, -0.16), (-0.36, -0.34)]),
                 fill: .color("#A8730C")),
            Part(shape: .poly, points: pts([(-0.4, 0.08), (0.4, 0.08), (0.44, -0.3), (0.22, -0.1), (0, -0.36), (-0.22, -0.1), (-0.44, -0.3)]),
                 fill: grad((0, -0.36), (0, 0.08), [(0, "#FFE58A"), (0.5, "#FBBF24"), (1, "#D08A0B")]),
                 stroke: .color("#D08A0B"), lw: 0.025, shine: (-0.44, 0.44),
                 react: React(state: .finished, glow: true, color: "#FFE08A")),
            Part(shape: .circle, x: -0.44, y: -0.33, r: 0.04, fill: .color("#FFF6CC")),
            Part(shape: .circle, x: 0, y: -0.39, r: 0.04, fill: .color("#FFF6CC")),
            Part(shape: .circle, x: 0.44, y: -0.33, r: 0.04, fill: .color("#FFF6CC")),
            Part(shape: .circle, y: -0.02, r: 0.065, fill: .color("#EF4444")),
            Part(shape: .circle, x: -0.25, y: 0, r: 0.05, fill: .color("#3B82F6")),
            Part(shape: .circle, x: 0.25, y: 0, r: 0.05, fill: .color("#22C55E")),
        ])
        case .sunglasses: return Costume(enter: .slide, parts: [
            Part(shape: .rect, anchor: .eyeL, w: 0.36, h: 0.25, r: 0.09, fill: .color("#1B1F2A")),
            Part(shape: .rect, anchor: .eyeR, w: 0.36, h: 0.25, r: 0.09, fill: .color("#1B1F2A")),
            Part(shape: .line, anchor: .eyes, points: pts([(-0.16, -0.03), (0.16, -0.03)]), stroke: .color("#1B1F2A"), lw: 0.045),
            Part(shape: .line, anchor: .eyeL, points: pts([(-0.11, -0.06), (-0.03, -0.09)]), stroke: .color("rgba(255,255,255,0.55)"), lw: 0.03),
            Part(shape: .line, anchor: .eyeR, points: pts([(-0.11, -0.06), (-0.03, -0.09)]), stroke: .color("rgba(255,255,255,0.55)"), lw: 0.03),
        ])
        case .roundGlasses: return Costume(enter: .slide, parts: [
            Part(shape: .circle, anchor: .eyeL, r: 0.17, fill: .color("rgba(220,240,255,0.16)"), stroke: .color("#8B5E34"), lw: 0.035),
            Part(shape: .circle, anchor: .eyeR, r: 0.17, fill: .color("rgba(220,240,255,0.16)"), stroke: .color("#8B5E34"), lw: 0.035),
            Part(shape: .line, anchor: .eyes, points: pts([(-0.17, -0.04), (0.17, -0.04)]), stroke: .color("#8B5E34"), lw: 0.03),
        ])
        case .bow: return Costume(enter: .pop, parts: [
            Part(shape: .ellipse, anchor: .side, x: -0.13, w: 0.28, h: 0.19, rot: -0.3, fill: .color("#F472B6")),
            Part(shape: .ellipse, anchor: .side, x: 0.13, w: 0.28, h: 0.19, rot: 0.3, fill: .color("#EC4899")),
            Part(shape: .circle, anchor: .side, r: 0.065, fill: .color("#DB2777")),
        ])
        case .scarf: return Costume(enter: .slide, parts: [
            Part(shape: .rect, anchor: .neck, w: 2.4, h: 0.22, r: 0.1, fill: .color("#EF4444"), clipBody: true),
            Part(shape: .rect, anchor: .neck, x: -0.5, w: 0.09, h: 0.22, fill: .color("rgba(255,255,255,0.85)"), clipBody: true),
            Part(shape: .rect, anchor: .neck, x: 0, w: 0.09, h: 0.22, fill: .color("rgba(255,255,255,0.85)"), clipBody: true),
            Part(shape: .rect, anchor: .neck, x: 0.5, w: 0.09, h: 0.22, fill: .color("rgba(255,255,255,0.85)"), clipBody: true),
            Part(shape: .poly, anchor: .neck, x: -0.36, points: pts([(-0.1, 0), (0.1, 0), (0.13, 0.42), (-0.1, 0.44)]), fill: .color("#DC2626"), spring: 1),
            Part(shape: .circle, anchor: .neck, x: -0.36, r: 0.1, fill: .color("#F87171")),
        ])
        case .witchHat: return Costume(enter: .drop, seat: (anchor: .brim, y: 0), parts: [
            Part(shape: .ellipse, anchor: .brim, behind: true, w: 2.5, h: 0.54, fill: grad((0, -0.27), (0, 0.27), [(0, "#2A0A4F"), (1, "#3B0F6B")])),
            Part(shape: .halfEllipse, anchor: .brim, w: 2.5, h: 0.27, rot: .pi, fill: grad((0, 0.27), (0, 0), [(0, "#5B21B6"), (1, "#3B0764")])),
            Part(shape: .halfEllipse, anchor: .brim, w: 2.5, h: 0.27, rot: .pi, stroke: .color("rgba(190,150,255,0.4)"), lw: 0.035, open: true),
            Part(shape: .path, anchor: .brim,
                 d: "M -0.74 0 C -0.66 -0.48 -0.2 -0.86 0.1 -1.16 Q 0.36 -1.24 0.66 -1.0 Q 0.4 -1.04 0.3 -0.9 C 0.46 -0.52 0.7 -0.26 0.74 0 Q 0 0.15 -0.74 0 Z",
                 fill: grad((-0.74, -1.1), (0.74, 0), [(0, "#7C3AED"), (0.55, "#4C1D95"), (1, "#2E1065")]), shine: (-0.74, 0.74), spring: 0.5),
            Part(shape: .path, anchor: .brim, d: "M 0.05 -1.06 Q 0.2 -0.99 0.34 -1.05", stroke: .color("rgba(20,0,40,0.35)"), lw: 0.05, spring: 0.5),
            Part(shape: .path, anchor: .brim, d: "M -0.72 -0.1 Q 0 0.05 0.72 -0.1", stroke: .color("#F97316"), lw: 0.15, spring: 0.5),
            Part(shape: .rect, anchor: .brim, y: -0.03, w: 0.22, h: 0.17, r: 0.04, fill: grad((0, -0.09), (0, 0.09), [(0, "#FDE68A"), (1, "#F59E0B")]), spring: 0.5),
            Part(shape: .rect, anchor: .brim, y: -0.03, w: 0.11, h: 0.07, r: 0.015, fill: .color("#C2410C"), spring: 0.5),
        ])
        case .pumpkin: return Costume(enter: .fade, body: ("#FFA94D", "#E8590C"), parts: [
            Part(shape: .ellipse, anchor: .body, w: 0.66, h: 1.64, stroke: .color("rgba(150,50,0,0.25)"), lw: 0.07, clipBody: true),
            Part(shape: .ellipse, anchor: .body, w: 1.4, h: 1.64, stroke: .color("rgba(150,50,0,0.2)"), lw: 0.07, clipBody: true),
            Part(shape: .poly, points: pts([(-0.07, 0.06), (0.06, 0.06), (0.11, -0.2), (0.02, -0.24)]), fill: .color("#4D7C0F")),
            Part(shape: .ellipse, x: -0.17, y: -0.06, w: 0.32, h: 0.12, rot: -0.5, fill: .color("#65A30D"), spring: 1),
        ])
        case .santaHat: return Costume(enter: .drop, parts: [
            Part(shape: .poly, points: pts([(-0.46, 0.08), (0.46, 0.08), (0.3, -0.42), (0.64, -0.62), (0.1, -0.62)]),
                 fill: grad((-0.46, -0.6), (0.46, 0.08), [(0, "#F87171"), (1, "#B91C1C")]), shine: (-0.46, 0.64), spring: 1),
            Part(shape: .rect, y: 0.09, w: 1.14, h: 0.22, r: 0.11, fill: white, stroke: .color("#DADDE4"), lw: 0.02),
            Part(shape: .circle, x: 0.66, y: -0.62, r: 0.12, fill: white, stroke: .color("#DADDE4"), lw: 0.02, spring: 1),
        ])
        case .bunnyEars: return Costume(enter: .drop, parts: [
            Part(shape: .ellipse, behind: true, x: -0.32, y: -0.42, w: 0.26, h: 0.86, rot: -0.15, fill: .color("#F9F0F0"), stroke: .color("rgba(0,0,0,0.06)"), lw: 0.015, spring: 1),
            Part(shape: .ellipse, behind: true, x: -0.32, y: -0.4, w: 0.12, h: 0.56, rot: -0.15, fill: .color("rgba(252,165,165,0.7)"), spring: 1),
            Part(shape: .ellipse, behind: true, x: 0.32, y: -0.42, w: 0.26, h: 0.86, rot: 0.15, fill: .color("#F9F0F0"), stroke: .color("rgba(0,0,0,0.06)"), lw: 0.015, spring: 1),
            Part(shape: .ellipse, behind: true, x: 0.32, y: -0.4, w: 0.12, h: 0.56, rot: 0.15, fill: .color("rgba(252,165,165,0.7)"), spring: 1),
        ])
        }
    }

    // MARK: Paint

    /// "#RRGGBB" or "rgba(r,g,b,a)".
    static func color(_ s: String) -> Color {
        if s.hasPrefix("rgba(") {
            let n = TofuSVG.numbers(String(s.dropFirst(5)))
            guard n.count >= 4 else { return .clear }
            return Color(red: Double(n[0]) / 255, green: Double(n[1]) / 255, blue: Double(n[2]) / 255, opacity: Double(n[3]))
        }
        return Color(hex: s)
    }

    static func shading(_ p: Paint) -> GraphicsContext.Shading {
        switch p {
        case .color(let s):
            return .color(color(s))
        case .gradient(let from, let to, let stops):
            return .linearGradient(Gradient(stops: stops.map { .init(color: color($0.1), location: $0.0) }),
                                   startPoint: from, endPoint: to)
        }
    }

    /// An ellipse arc from `a0` to `a1` (radians, y down: increasing turns clockwise on screen).
    static func arcPoints(rx: CGFloat, ry: CGFloat, from a0: CGFloat, to a1: CGFloat, steps: Int = 32) -> [CGPoint] {
        (0...steps).map { i in
            let a = a0 + (a1 - a0) * CGFloat(i) / CGFloat(steps)
            return CGPoint(x: cos(a) * rx, y: sin(a) * ry)
        }
    }

    static func partPath(_ part: Part) -> Path {
        var p = Path()
        let w = part.w, h = part.h
        switch part.shape {
        case .ellipse:
            p.addEllipse(in: CGRect(x: -w / 2, y: -h / 2, width: w, height: h))
        case .circle:
            p.addEllipse(in: CGRect(x: -part.r, y: -part.r, width: part.r * 2, height: part.r * 2))
        case .rect:
            p.addRoundedRect(in: CGRect(x: -w / 2, y: -h / 2, width: w, height: h),
                             cornerSize: CGSize(width: min(part.r, w / 2), height: min(part.r, h / 2)))
        case .halfEllipse:
            // The top half (canvas ellipse from π to 2π).
            p.addLines(arcPoints(rx: w / 2, ry: h, from: .pi, to: .pi * 2))
            if !part.open { p.closeSubpath() }
        case .poly:
            p.addLines(part.points)
            p.closeSubpath()
        case .line:
            if part.points.count >= 2 { p.addLines(Array(part.points.prefix(2))) }
        case .path:
            if let d = part.d { p = TofuSVG.path(d) }
        }
        return p
    }

    // MARK: Layers

    /// Draws `body` at `alpha` as one layer, so overlapping parts don't show through each other.
    static func withLayer(_ ctx: GraphicsContext, _ alpha: CGFloat, _ body: (inout GraphicsContext) -> Void) {
        var c = ctx
        if alpha >= 0.999 {
            body(&c)
            return
        }
        c.opacity *= Double(alpha)
        c.drawLayer { layer in
            var l = layer
            body(&l)
        }
    }

    static func drawParts(_ ctx: GraphicsContext, _ g: Geometry, _ p: TofuPose, _ costume: Costume,
                          behind: Bool, R: CGFloat, only: (Part) -> Bool) {
        let t = CACurrentMediaTime()
        let look = Look(yaw: p.yaw, pitch: p.pitch, roll: p.roll, rigidRoll: p.rigidRoll)
        for part in costume.parts where part.behind == behind && only(part) {
            let a = anchorFrame(g, look, part.anchor)
            var c = ctx
            if part.clipBody { c.clip(to: g.path) }
            c.translateBy(x: a.x, y: a.y)
            c.rotate(by: .radians(a.rot))
            c.scaleBy(x: a.fx, y: a.fy)
            c.translateBy(x: part.x, y: part.y)
            if part.spring != 0 {
                c.translateBy(x: p.physDx * 0.1 * part.spring, y: p.physDy * 0.06 * part.spring)
                c.rotate(by: .radians(p.physDx * 0.22 * part.spring))
            }
            if let react = part.react, react.state == p.state {
                if react.glow {
                    // Canvas's shadowBlur is in pixels; here the context is in Tofu units.
                    let px = (8 + 14 * (0.5 + 0.5 * sin(t * 4))) * Double(R / 170)
                    c.addFilter(.shadow(color: color(react.color ?? "#FFF6A0"), radius: px / Double(R * unit)))
                } else {
                    c.translateBy(x: 0, y: CGFloat(sin(t * 6)) * 0.05)
                }
            }
            c.rotate(by: .radians(part.rot))
            let path = partPath(part)
            if let fill = part.fill, part.shape != .line, !part.open {
                c.fill(path, with: shading(fill))
                if let shine = part.shine {
                    var s = c
                    s.clip(to: path)
                    s.fill(Path(CGRect(x: -4, y: -4, width: 8, height: 8)), with: shading(.gradient(
                        from: CGPoint(x: shine.0, y: 0), to: CGPoint(x: shine.1, y: 0),
                        stops: [(0, "rgba(255,255,255,0.28)"), (0.4, "rgba(255,255,255,0)"), (1, "rgba(0,0,0,0.16)")])))
                }
            }
            if let stroke = part.stroke {
                c.stroke(path, with: shading(stroke), style: StrokeStyle(lineWidth: part.lw, lineCap: .round))
            }
        }
    }

    // MARK: Hat fitting

    /// The y values of a part's outline, relative to its anchor (y down).
    static func partYs(_ part: Part) -> [CGFloat] {
        let y = part.y, w = part.w, h = part.h, r = part.r
        switch part.shape {
        case .circle:
            return [y - r, y + r]
        case .ellipse:
            let half = (abs(sin(part.rot)) > 0.3 ? max(w, h) : h) / 2
            return [y - half, y + half]
        case .rect:
            return [y - h / 2, y + h / 2]
        case .halfEllipse:
            return abs(part.rot) > 1.5 ? [y, y + h] : [y - h, y]
        case .poly, .line:
            return part.points.map { y + $0.y }
        case .path:
            let n = TofuSVG.numbers(part.d ?? "")
            return n.enumerated().filter { $0.offset % 2 == 1 }.map { y + $0.element }
        }
    }

    struct Fit: Equatable { var s: CGFloat; var fy: CGFloat; var lift: CGFloat }

    /// Hats never cover the eyes. A hat that reaches below the top of the eyes is
    /// lifted; if lifting would take it off the head, it is flattened instead, so it
    /// still sits on the head. Worked out at rest.
    static func hatFit(_ g: Geometry, _ costume: Costume) -> Fit {
        let C = anchorFrame(g, .rest, .crown).y
        let B = anchorFrame(g, .rest, .brim).y
        func rel(_ anchor: Anchor) -> CGFloat { anchor == .brim ? B - C : 0 }
        var low = -CGFloat.infinity
        for part in costume.parts where (part.anchor == .crown || part.anchor == .brim) && !part.behind {
            low = max(low, rel(part.anchor) + (partYs(part).max() ?? -.infinity))
        }
        let s = g.hatScale
        guard low > -.infinity else { return Fit(s: s, fy: 1, lift: 0) }
        let seat = costume.seat.map { rel($0.anchor) + $0.y } ?? low - 0.1
        let eyeTop = g.eye.y - g.eye.h / 2
        let gap: CGFloat = 0.03
        let onHead: CGFloat = 0.02
        var fy: CGFloat = 1
        var lift = max(0, C + low * s - (eyeTop - gap))
        let maxLift = max(0, C + seat * s - (g.top + onHead))
        if lift > maxLift {
            fy = max(0.3, min(1, (eyeTop - gap - g.top - onHead) / (s * (low - seat))))
            lift = max(0, C + low * s * fy - (eyeTop - gap))
        }
        return Fit(s: s, fy: fy, lift: lift)
    }

    /// Every hat's fit, worked out once.
    static let fits: [Outfit: Fit] = {
        var out: [Outfit: Fit] = [:]
        for outfit in Outfit.allCases {
            if let c = costume(outfit), c.enter == .drop { out[outfit] = hatFit(geo, c) }
        }
        return out
    }()

    /// Mochi's layerAlpha: the outfit fades with its presence and away into the mailbox.
    static func layerAlpha(_ p: TofuPose) -> CGFloat {
        let morphFade = 1 - min(1, max(0, (p.morph - 0.3) / 0.2))
        return morphFade * min(1, p.presence * 2.5)
    }

    static func drawOutfit(_ ctx: GraphicsContext, _ g: Geometry, _ p: TofuPose, behind: Bool, R: CGFloat) {
        guard let costume = costume(p.outfit), costume.parts.contains(where: { $0.behind == behind }) else { return }
        let alpha = layerAlpha(p)
        guard alpha > 0.005 else { return }
        let posP = Ease.back(p.presence)
        let look = Look(yaw: p.yaw, pitch: p.pitch, roll: p.roll, rigidRoll: p.rigidRoll)

        switch costume.enter {
        case .drop:
            // Only the hat drops (Mochi's 0.88 R), scales and fits the head.
            let fit = fits[p.outfit] ?? Fit(s: g.hatScale, fy: 1, lift: 0)
            let s = (0.85 + 0.15 * posP) * fit.s
            var c = ctx
            c.translateBy(x: 0, y: -(1 - posP) * (0.88 / unit) - fit.lift)
            let a = anchorFrame(g, look, .crown)
            c.translateBy(x: a.x, y: a.y)
            c.scaleBy(x: s, y: s * fit.fy)
            c.translateBy(x: -a.x, y: -a.y)
            withLayer(c, alpha) { l in drawParts(l, g, p, costume, behind: behind, R: R, only: { $0.isHat }) }
            if costume.parts.contains(where: { !$0.isHat && $0.behind == behind }) {
                withLayer(ctx, alpha) { l in drawParts(l, g, p, costume, behind: behind, R: R, only: { !$0.isHat }) }
            }
        case .slide, .pop, .fade:
            var c = ctx
            if costume.enter == .slide {
                // Mochi's slides: glasses come down 0.25 ry, the scarf 0.3 ry.
                c.translateBy(x: 0, y: ((1 - p.presence) * (p.outfit == .scarf ? 0.3 : 0.25) * 0.88) / unit)
            } else if costume.enter == .pop {
                let a = anchorFrame(g, look, costume.parts[0].anchor)
                let s = max(0.001, posP)
                c.translateBy(x: a.x, y: a.y)
                c.scaleBy(x: s, y: s)
                c.translateBy(x: -a.x, y: -a.y)
            }
            withLayer(c, alpha) { l in drawParts(l, g, p, costume, behind: behind, R: R, only: { _ in true }) }
        }
    }

    // MARK: Body

    /// Hands come out only to wave, in the body's colour.
    static func drawHands(_ ctx: GraphicsContext, _ g: Geometry, _ p: TofuPose) {
        let n = CACurrentMediaTime()
        let waving = n >= p.waveStart && p.waveStart > 0 && n < p.waveUntil
        let hwB = g.halfW * p.sx
        let hhB = g.halfH * p.sy
        let bodyH = 2 * g.halfH
        for sd in [-1.0, 1.0] as [CGFloat] {
            var lx = sd * hwB * 1.08
            var ly = hhB * 0.7
            var rot: CGFloat = 0
            if sd > 0 && waving {
                let wt = CGFloat(n - p.waveStart)
                let rise = min(1, wt / 0.18)
                let re = 1 - pow(1 - rise, 3)
                let wx = hwB * 1.1 + cos(13 * wt) * 0.06 * bodyH
                let wy = -hhB * 0.15 - sin(13 * wt) * 0.14 * bodyH
                lx += (wx - lx) * re
                ly += (wy - ly) * re
                rot = (-0.5 + sin(13 * wt) * 0.35) * re
            } else if sd < 0 && waving {
                ly += sin(6 * CGFloat(n - p.waveStart)) * 0.04 * bodyH
            }
            var c = ctx
            c.translateBy(x: lx, y: ly)
            c.rotate(by: .radians(rot))
            let hand = Path(ellipseIn: CGRect(x: -0.3 * g.halfH * p.hands, y: -0.26 * g.halfH * p.hands,
                                              width: 0.6 * g.halfH * p.hands, height: 0.52 * g.halfH * p.hands))
            c.fill(hand, with: .color(p.fill))
            c.stroke(hand, with: .color(.black.opacity(0.08)), lineWidth: 0.015)
        }
    }

    /// Draws Tofu with its centre at (`cx`, `cy`) for an engine radius `R`.
    /// The caller has already turned the context for a dressed roll.
    static func draw(_ context: GraphicsContext, pose p: TofuPose, R: CGFloat, cx: CGFloat, cy: CGFloat, hooks: TofuHooks) {
        let g = geo
        let u = R * unit
        var x = context
        x.translateBy(x: cx, y: cy)
        if p.tilt != 0 { x.rotate(by: .radians(p.tilt)) }
        x.scaleBy(x: u, y: u)
        if p.hands > 0.01 && !p.isMini && R > 14 { drawHands(x, g, p) }
        x.scaleBy(x: p.sx, y: p.sy)

        drawOutfit(x, g, p, behind: true, R: R)

        x.fill(g.path, with: .color(p.fill))
        var inner = x
        inner.clip(to: g.path)
        let costume = costume(p.outfit)
        let recolour = costume?.body != nil ? min(1, p.presence * 2.5) * (1 - p.morph) : 0
        if let body = costume?.body, recolour > 0.001 {
            var r = inner
            r.opacity *= Double(recolour)
            r.fill(Path(CGRect(x: -2, y: -2, width: 4, height: 4)), with: .linearGradient(
                Gradient(colors: [color(body.0), color(body.1)]),
                startPoint: CGPoint(x: g.halfW * 0.7, y: -g.halfH), endPoint: CGPoint(x: -g.halfW * 0.8, y: g.halfH)))
        }
        let tint = p.tint * (1 - p.morph)
        if tint > 0.01 {
            let tc = Color(red: Double(p.col.0), green: Double(p.col.1), blue: Double(p.col.2))
            inner.fill(Path(CGRect(x: -2, y: -2, width: 4, height: 4)), with: .linearGradient(
                Gradient(stops: [.init(color: tc.opacity(Double(0.72 * tint)), location: 0),
                                 .init(color: tc.opacity(0), location: 1)]),
                startPoint: CGPoint(x: 0, y: g.halfH), endPoint: CGPoint(x: 0, y: -g.halfH)))
        }
        if let over = hooks.overBody {
            var o = inner
            o.scaleBy(x: 1 / u, y: 1 / u)
            over(&o, g.path.applying(CGAffineTransform(scaleX: u, y: u)), g.halfW * u, g.halfH * u)
        }
        // Mochi's cheeks: only while blushing or tinted.
        let blush = max(p.blush, p.tint * 0.5) * (1 - p.morph)
        if blush > 0.01 {
            let cw = g.eye.w * 0.7
            let chy = g.eye.y + g.eye.h * 0.62
            for sd in [-1.0, 1.0] as [CGFloat] {
                let bx = sd * (g.eye.gap / 2 + g.eye.w * 0.55) + sin(p.yaw) * g.halfW * 0.8
                inner.fill(Path(ellipseIn: CGRect(x: bx - cw, y: chy - cw * 0.6, width: cw * 2, height: cw * 1.2)),
                           with: .color(Color(red: 1, green: 120 / 255, blue: 150 / 255, opacity: Double(0.5 * blush))))
            }
        }
        // Eyes on the face ellipsoid, clipped by the outline: they roll out over the top and back from below.
        let scale = p.es * (p.isMini ? miniEyes : 1)
        let look = Look(yaw: p.yaw, pitch: p.pitch, roll: p.roll, rigidRoll: p.rigidRoll)
        for sd in [-1.0, 1.0] as [CGFloat] {
            let f = facePoint(g, look, yawOff: sd * g.eyeSp, pitchOff: g.eyeP, withRoll: true)
            guard f.visible else { continue }
            var e = inner
            e.translateBy(x: f.x, y: f.y + (p.morph > 0 ? g.face.ry * 0.14 * p.morph : 0))
            e.scaleBy(x: f.fx + (1 - f.fx) * p.morph * 0.7, y: f.fy + (1 - f.fy) * p.morph * 0.7)
            hooks.eye(&e, p.eye, g.eye.w * scale, g.eye.h * scale, sd)
        }

        if p.morph > 0.05, let mouth = hooks.mouth {
            var m = x
            m.scaleBy(x: 1 / u, y: 1 / u)
            mouth(&m, g.path.applying(CGAffineTransform(scaleX: u, y: u)))
        }

        drawOutfit(x, g, p, behind: false, R: R)
    }

    // MARK: Wardrobe icon

    /// A little Tofu wearing `outfit`, placed like the wardrobe's little Mochi.
    static func drawStill(_ context: GraphicsContext, size: CGSize, outfit: Outfit, fill: Color) {
        let R: CGFloat = 10
        var pose = TofuPose()
        pose.outfit = outfit
        pose.presence = 1
        pose.fill = fill
        let hooks = TofuHooks(eye: { c, _, w, h, _ in
            let r = min(w, h) / 2
            c.fill(Path(roundedRect: CGRect(x: -w / 2, y: -h / 2, width: w, height: h), cornerRadius: r),
                   with: .color(Color(hex: "#141414")))
        })
        draw(context, pose: pose, R: R, cx: size.width / 2, cy: size.height / 2 + R * 0.62, hooks: hooks)
    }
}
