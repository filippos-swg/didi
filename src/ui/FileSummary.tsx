import { formatBytes } from "../format.ts";

export function FileSummary({ file }: { file: { name: string; size: number } }) {
  return (
    <p className="file">
      <span className="file-name">{file.name}</span> <span className="file-size">{formatBytes(file.size)}</span>
    </p>
  );
}
