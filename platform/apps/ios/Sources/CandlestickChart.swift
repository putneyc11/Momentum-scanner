import SwiftUI

struct CandlestickChart: View {
    var bars: [PriceBar]
    var timeframe: Timeframe
    @State private var visibleCount = 55
    @State private var offset = 0
    @State private var dragStartOffset: Int?
    @State private var pinchStartCount: Int?
    @State private var selectedID: Double?
    @State private var inspecting = false
    private var visibleBars: [PriceBar] { Array(bars[ChartWindow.range(count: bars.count, visible: visibleCount, offset: offset)]) }
    private var selected: PriceBar? { visibleBars.first { $0.id == selectedID } ?? visibleBars.last }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                if let bar = selected {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(bar.date.formatted(date: .abbreviated, time: .shortened)).font(.caption2).foregroundStyle(.secondary)
                        HStack(spacing: 8) {
                            mini("O", bar.open); mini("H", bar.high); mini("L", bar.low); mini("C", bar.close)
                        }
                    }
                }
                Spacer(minLength: 0)
            }.frame(minHeight: 34)
            GeometryReader { geometry in
                Canvas { context, size in
                    let displayed = visibleBars
                    guard !displayed.isEmpty else { return }
                    let plotWidth = max(1, size.width - 52)
                    let priceHeight = max(1, size.height - 66)
                    let volumeTop = priceHeight + 8
                    let minPrice = displayed.map(\.low).min() ?? 0
                    let maxPrice = displayed.map(\.high).max() ?? 1
                    let padding = max((maxPrice - minPrice) * 0.08, maxPrice * 0.0005)
                    let lower = minPrice - padding
                    let upper = maxPrice + padding
                    let spread = max(0.00001, upper - lower)
                    let step = plotWidth / Double(displayed.count)
                    let candleWidth = max(1, min(12, step * 0.62))
                    func y(_ price: Double) -> Double { priceHeight * (1 - (price - lower) / spread) }
                    for index in 0...4 {
                        let lineY = priceHeight * Double(index) / 4
                        var path = Path(); path.move(to: CGPoint(x: 0, y: lineY)); path.addLine(to: CGPoint(x: plotWidth, y: lineY))
                        context.stroke(path, with: .color(Palette.line), style: StrokeStyle(lineWidth: 1, dash: [3, 4]))
                        let label = Text((upper - spread * Double(index) / 4).formatted(.number.precision(.fractionLength(maxPrice < 1 ? 4 : 2)))).font(.system(size: 9, design: .monospaced)).foregroundColor(.secondary)
                        context.draw(label, at: CGPoint(x: plotWidth + 5, y: max(6, min(priceHeight - 5, lineY))), anchor: .leading)
                    }
                    let maxVolume = max(1, displayed.map(\.volume).max() ?? 1)
                    for (index, bar) in displayed.enumerated() {
                        let x = step * (Double(index) + 0.5)
                        let color = bar.close >= bar.open ? Palette.mint : Palette.red
                        var wick = Path(); wick.move(to: CGPoint(x: x, y: y(bar.high))); wick.addLine(to: CGPoint(x: x, y: y(bar.low)))
                        context.stroke(wick, with: .color(color), lineWidth: 1)
                        let rectangle = CGRect(x: x - candleWidth / 2, y: min(y(bar.open), y(bar.close)), width: candleWidth, height: max(1, abs(y(bar.open) - y(bar.close))))
                        context.fill(Path(rectangle), with: .color(color))
                        let volumeHeight = max(1, 33 * bar.volume / maxVolume)
                        context.fill(Path(CGRect(x: x - candleWidth / 2, y: volumeTop + 33 - volumeHeight, width: candleWidth, height: volumeHeight)), with: .color(color.opacity(0.28)))
                        if bar.id == selectedID {
                            var crosshair = Path(); crosshair.move(to: CGPoint(x: x, y: 0)); crosshair.addLine(to: CGPoint(x: x, y: volumeTop + 33))
                            crosshair.move(to: CGPoint(x: 0, y: y(bar.close))); crosshair.addLine(to: CGPoint(x: plotWidth, y: y(bar.close)))
                            context.stroke(crosshair, with: .color(Color.white.opacity(0.5)), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                            context.fill(Path(ellipseIn: CGRect(x: x - 3, y: y(bar.close) - 3, width: 6, height: 6)), with: .color(.white))
                        }
                    }
                    if let tail = displayed.last {
                        var priceLine = Path(); priceLine.move(to: CGPoint(x: 0, y: y(tail.close))); priceLine.addLine(to: CGPoint(x: plotWidth, y: y(tail.close)))
                        context.stroke(priceLine, with: .color(Palette.mint.opacity(0.35)), style: StrokeStyle(lineWidth: 1, dash: [2, 3]))
                    }
                    for index in [0, displayed.count / 2, displayed.count - 1] {
                        let bar = displayed[index]
                        let text = timeframe == .day ? bar.date.formatted(.dateTime.month(.abbreviated).day()) : bar.date.formatted(.dateTime.hour().minute())
                        let x = max(22, min(plotWidth - 22, step * (Double(index) + 0.5)))
                        context.draw(Text(text).font(.system(size: 9, design: .monospaced)).foregroundColor(.secondary), at: CGPoint(x: x, y: size.height - 7))
                    }
                }
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 2).onChanged { value in
                    let plotWidth = max(1, geometry.size.width - 52)
                    if inspecting {
                        let index = max(0, min(visibleBars.count - 1, Int(value.location.x / plotWidth * Double(visibleBars.count))))
                        if visibleBars.indices.contains(index) { selectedID = visibleBars[index].id }
                    } else {
                        if dragStartOffset == nil { dragStartOffset = offset }
                        let shift = Int(value.translation.width / plotWidth * Double(visibleCount))
                        offset = max(0, min(max(0, bars.count - min(visibleCount, bars.count)), (dragStartOffset ?? 0) + shift))
                        selectedID = nil
                    }
                }.onEnded { _ in dragStartOffset = nil })
                .simultaneousGesture(MagnifyGesture().onChanged { value in
                    if pinchStartCount == nil { pinchStartCount = visibleCount }
                    visibleCount = max(12, min(300, Int(Double(pinchStartCount ?? 55) / value.magnification)))
                    clampOffset()
                }.onEnded { _ in pinchStartCount = nil })
                .onTapGesture { location in
                    let index = max(0, min(visibleBars.count - 1, Int(location.x / max(1, geometry.size.width - 52) * Double(visibleBars.count))))
                    if visibleBars.indices.contains(index) { selectedID = visibleBars[index].id }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Candlestick chart, \(timeframe.label) intervals, \(visibleBars.count) visible bars")
                .accessibilityValue(selected.map { "\($0.date.formatted()), open \(Display.price($0.open)), high \(Display.price($0.high)), low \(Display.price($0.low)), close \(Display.price($0.close))" } ?? "No bars available")
            }.frame(height: 272)
            HStack(spacing: 17) {
                Button { visibleCount = min(300, visibleCount + 15); clampOffset() } label: { Image(systemName: "minus.magnifyingglass") }.accessibilityLabel("Zoom out")
                Button { visibleCount = max(12, visibleCount - 15); clampOffset() } label: { Image(systemName: "plus.magnifyingglass") }.accessibilityLabel("Zoom in")
                Button { inspecting.toggle() } label: { Image(systemName: "scope").foregroundStyle(inspecting ? Palette.mint : .secondary) }.accessibilityLabel(inspecting ? "Switch to pan mode" : "Switch to inspect mode")
                Spacer()
                Button { offset = 0; visibleCount = 55; selectedID = nil } label: { Label("Latest", systemImage: "arrow.right.to.line").font(.caption) }
            }.font(.body).buttonStyle(.plain).foregroundStyle(Palette.mint)
            Text(inspecting ? "Drag to inspect a candle. Tap the crosshair to pan." : "Drag to pan · pinch to zoom · tap to inspect")
                .font(.system(size: 10)).foregroundStyle(.secondary)
        }
        .onChange(of: timeframe) { _, _ in offset = 0; selectedID = nil; visibleCount = 55 }
    }
    private func clampOffset() { offset = max(0, min(offset, max(0, bars.count - visibleCount))) }
    private func mini(_ label: String, _ value: Double) -> some View {
        HStack(spacing: 2) {
            Text(label).foregroundStyle(.secondary)
            Text(Display.metric(value)).foregroundStyle(.primary)
        }.font(.system(size: 9, weight: .medium, design: .monospaced)).minimumScaleFactor(0.65).lineLimit(1)
    }
}
