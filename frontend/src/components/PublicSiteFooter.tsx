import { Fragment } from "react";
import "./public-site-footer.css";

export function PublicSiteFooter({ links }: { links: Array<{ href: string; label: string; external?: boolean }> }) {
  return (
    <footer className="public-site-footer" role="contentinfo" aria-label="网站页脚">
      <nav className="public-site-footer-nav" aria-label="页脚导航">
        <ul className="public-site-footer-links" role="list">
          {links.map(({ href, label, external }, index) => (
            <Fragment key={href}>
              {index > 0 && <li aria-hidden="true">·</li>}
              <li>
                <a href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined}>{label}</a>
              </li>
            </Fragment>
          ))}
        </ul>
      </nav>
      {window.location.hostname === "xiaocheng.online" && (
        <a className="public-site-footer-icp" href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">
          鄂ICP备2026067631号-1
        </a>
      )}
    </footer>
  );
}
