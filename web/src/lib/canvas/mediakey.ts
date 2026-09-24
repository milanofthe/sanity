// What a picture is held by: the file, which version of it, and which page.
//
// The picture pipeline caches by key and asks the source for bytes by key, so
// the key has to say everything the bytes depend on. It used to be the path,
// with `#page=n` for a page of a document, and that was not enough: a picture
// that changed on disk kept its key and was drawn as it had been, and one
// shown at a commit was fetched from the disk, where it could be different or
// gone. With the version in the key, a changed picture is a new one, and one
// at a commit is fetched from the commit; see `FileInfo::version` in
// src-tauri/src/lib.rs.
//
// Joined with NUL, which no file name on any system can contain, so a path
// with a # or an @ in it cannot be read as something else.

const SEP = '\u0000';

export interface MediaRef {
  path: string;
  /** The file's time and size on disk, or `blob:<id>` in the history. */
  version?: string;
  /** A page of a document shown as all of its pages. */
  page?: number;
}

/** The key for a picture. A picture with neither a version nor a page is
 *  keyed by its path alone, as sources without versions have always done. */
export function mediaKey(path: string, version?: string, page?: number): string {
  if (!version && page === undefined) return path;
  return `${path}${SEP}${version ?? ''}${SEP}${page ?? ''}`;
}

export function parseMediaKey(key: string): MediaRef {
  const parts = key.split(SEP);
  if (parts.length < 3) return { path: key };
  const [path, version, page] = parts;
  return {
    path,
    ...(version ? { version } : {}),
    ...(page !== '' ? { page: Number(page) } : {}),
  };
}

/** The file a key is for, for what depends on it, like its extension. */
export function mediaPath(key: string): string {
  const i = key.indexOf(SEP);
  return i < 0 ? key : key.slice(0, i);
}
