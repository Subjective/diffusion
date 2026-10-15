import { Moon, PanelRight, RefreshCw, Route, Sparkles, Sun } from "lucide-react";
import { useApp } from "../store";
import { GithubIcon, ic } from "./icons";

export function TopBar() {
  const { url, setUrl, load, generate, theme, toggleTheme, chatOpen, toggleChat, guide, generating, pr } = useApp();
  const loaded = pr && url.trim() === pr.url;
  const canRegen = loaded && guide && !generating;

  return (
    <header className="top">
      <div className="brand">{ic(Route, 16)}</div>
      <form
        className="url"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <GithubIcon />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="PR URL, or local:/path/to/repo#main..feature"
          spellCheck={false}
          aria-label="Pull request URL"
        />
        {canRegen ? (
          <button type="button" className="icon-btn solid" title="Regenerate guide" onClick={() => void generate(true)}>
            {ic(RefreshCw, 15)}
          </button>
        ) : (
          <button type="submit" className="icon-btn solid" title="Generate guide" disabled={!url.trim()}>
            {ic(Sparkles, 16)}
          </button>
        )}
      </form>
      <div className="top-r">
        <button type="button" className="icon-btn" title="Theme" onClick={toggleTheme}>
          {ic(theme === "dark" ? Sun : Moon, 17)}
        </button>
        <button type="button" className={`icon-btn${chatOpen ? " on" : ""}`} title="Chat" onClick={() => toggleChat()}>
          {ic(PanelRight, 16)}
        </button>
      </div>
    </header>
  );
}
