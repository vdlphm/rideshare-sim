import { useReducer } from "react";
import { DRIVER } from "../const";
import { Marker, Popup } from "react-leaflet";

function Driver({ runSim, debug }) {
  const [driver, driverDispatch] = useReducer(null, DRIVER);

  return (
    <div className="rider">
      {runSim
        ? driver.map((driver) => (
            <Marker
              key={"driver-" + driver.email}
              position={driver.location}
              icon={driver.icon}
            >
              <Popup>
                {driver.email}
                {debug ? (
                  <div>
                    {driver.location}
                    <br />
                    {driver.destination}
                  </div>
                ) : null}
              </Popup>
            </Marker>
          ))
        : null}
    </div>
  );
}

export default Driver;
