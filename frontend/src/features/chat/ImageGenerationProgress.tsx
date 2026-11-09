import "./run-process.css";

export function ImageGenerationProgress() {
  return <div className="image-generation-progress" role="status" aria-label="正在生成图片" aria-live="polite">
    <svg className="image-generation-dots" viewBox="0 0 80 80" width="120" height="120" aria-hidden="true" focusable="false">
      {Array.from({ length: 49 }, (_, index) => {
        const row = Math.floor(index / 7);
        const column = index % 7;
        return <circle key={index} cx={10 + column * 10} cy={10 + row * 10} r="2"
          style={{ animationDelay: `${-(row + column) * 0.13}s` }} />;
      })}
    </svg>
  </div>;
}
