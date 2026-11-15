// The root layout: the map fills the window, so there is no chrome around pages, only credits.
import "./styles.css";
import type { LayoutProps } from "northstack";

export default function RootLayout({ children }: LayoutProps) {
  return (
    <>
      {children}
      <footer className="credits">
        Railways © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Imagery © Esri, Maxar,
        Earthstar Geographics · Elevation: Mapzen Terrarium (AWS Open Data)
      </footer>
    </>
  );
}
