import { useReducer } from "react";
import { RIDERS } from "../const";
import { Marker, Polyline, Popup } from "react-leaflet";

function Rider({ runSim, debug }) {
  const [riders, dispatchRiders] = useReducer(null, RIDERS);

  return (
    <div className="rider">
      {runSim
        ? riders.map((rider) => (
            <div>
              <Marker
                key={"rider" + rider.email}
                position={rider.location}
                icon={rider.icon}
              >
                <Popup>
                  {rider.email}
                  {debug ? (
                    <div>
                      {rider.location}
                      <br />
                      {rider.destination}
                    </div>
                  ) : null}
                </Popup>
              </Marker>
              {/* <Polyline></Polyline> */}
            </div>
          ))
        : null}
    </div>
  );
}

export default Rider;
