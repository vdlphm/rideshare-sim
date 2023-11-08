import "./App.css";
import { MapContainer, TileLayer } from "react-leaflet";
import { CENTER } from "./const";
import { useState } from "react";
import Rider from "./models/riders";
import Driver from "./models/drivers";

function App() {
  const [runSim, setRunSim] = useState(false),
    [debug, setDebug] = useState(false);

  return (
    <div>
      <MapContainer
        center={CENTER}
        zoom={14}
        scrollWheelZoom={false}
        zoomControl={false}
        dragging={false}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <Rider runSim={runSim} debug={debug} />
        <Driver runSim={runSim} debug={debug} />
      </MapContainer>
      <button onClick={() => setRunSim(!runSim)}>
        {runSim ? "Stop Simulation" : "Start Simulation"}
      </button>
      <button onClick={() => setDebug(!debug)}>
        {debug ? "Stop debug" : "Start debug"}
      </button>
    </div>
  );
}

export default App;
