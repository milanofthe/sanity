// Where the history ticker is: the commits it can step through, which one
// the canvas shows, and which one it was asked to go to.

export interface Commit {
  sha: string;
  /** Committer time, seconds since the epoch. */
  time: number;
  author: string;
  subject: string;
}

class HistoryState {
  /** Along the first parent, newest first. Empty when the folder has no git
   *  history, which is what hides the ticker. */
  commits = $state<Commit[]>([]);
  /** What the canvas shows: an index into `commits`, or -1 for the working
   *  tree. */
  at = $state(-1);
  /** Where the ticker was sent. The canvas catches up one step at a time,
   *  always from what it shows straight to this, so a burst of clicks is one
   *  step and not a queue of them. */
  target = $state(-1);

  get shown(): Commit | null {
    return this.at >= 0 ? (this.commits[this.at] ?? null) : null;
  }
}

export const history = new HistoryState();
