import "./public-site-footer.css";

export function PublicSiteFooter({ href, label }: { href: string; label: string }) {
  return (
    <footer className="public-site-footer" role="contentinfo" aria-label="网站页脚">
      <nav aria-label="页脚导航">
        <a className="public-site-footer-nav-link" href={href}>{label}</a>
      </nav>
      {window.location.hostname === "xiaocheng.online" && (
        <a className="public-site-footer-icp" href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">
          鄂ICP备2026067631号-1
        </a>
      )}
    </footer>
  );
}
