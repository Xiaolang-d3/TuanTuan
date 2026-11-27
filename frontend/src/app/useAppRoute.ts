import { useEffect, useRef, useState } from "react";
import { appRouteHash, initialAppRoute, isProductIntroHash, parseAppHash, routeForSection, type AppRoute } from "../routing";
import type { ViewKey } from "../types";

/** 读取并同步应用路由，返回页面导航方法和用于判断导航是否过期的计数。 */
export function useAppRoute() {
  const [appRoute, setAppRoute] = useState<AppRoute>(() => initialAppRoute(window.location.hash));
  // 用户操作和浏览器导航共用此计数，供异步加载判断导航是否已被替代。
  const navigationIntent = useRef(0);

  function navigateRoute(route: AppRoute, replace = false) {
    navigationIntent.current += 1;
    const nextHash = appRouteHash(route);
    const nextRoute = parseAppHash(nextHash) ?? route;
    setAppRoute(nextRoute);
    if (replace) {
      window.history.replaceState(null, "", nextHash);
    } else if (window.location.hash !== nextHash) {
      window.location.hash = nextHash;
    }
  }

  function setActiveView(view: ViewKey) {
    navigateRoute(routeForSection(view));
  }

  useEffect(() => {
    const canonicalHash = appRouteHash(initialAppRoute(window.location.hash));
    if (window.location.hash !== canonicalHash) {
      window.history.replaceState(null, "", canonicalHash);
    }
    function syncRoute() {
      if (isProductIntroHash(window.location.hash)) return;
      navigationIntent.current += 1;
      const next = initialAppRoute(window.location.hash);
      const canonicalHash = appRouteHash(next);
      if (window.location.hash !== canonicalHash) {
        window.history.replaceState(null, "", canonicalHash);
      }
      setAppRoute(next);
    }
    window.addEventListener("hashchange", syncRoute);
    return () => window.removeEventListener("hashchange", syncRoute);
  }, []);

  return { appRoute, navigateRoute, navigationIntent, setActiveView };
}
