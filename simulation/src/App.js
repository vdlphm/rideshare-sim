import "./App.css";
import {
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  Polyline,
} from "react-leaflet";
import { RIDERS, CENTER, ROUTES } from "./const";
import { useState } from "react";

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
        {RIDERS.map(function (rider) {
          return (
            <Marker key={rider.email} position={rider.location}>
              <Popup>
                {rider.email} <br /> {debug ? rider.location : ""} <br />
                {debug ? rider.destination : ""}
              </Popup>
            </Marker>
          );
        })}
        {ROUTES.map(function (route, index) {
          return <Polyline key={index} positions={route} />;
        })}
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
