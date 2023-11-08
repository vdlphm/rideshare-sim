import * as L from "leaflet";

export const CENTER = [47.68357, -122.26557];

const LeafIcon = L.Icon.extend({
  options: {},
});

export const RIDERS = [
    {
      email: "rider1@test.com",
      password: "password",
      first_name: "first",
      last_name: "last",
      location: [47.67357, -122.26557],
      destination: [47.67488, -122.26207],
      color: "2ecc71",
      icon: new LeafIcon({
        iconUrl:
          "https://chart.apis.google.com/chart?chst=d_map_pin_letter&chld=|2ecc71",
      }),
    },
  ],
  DRIVER = [
    {
      email: "driver1@test.com",
      password: "password",
      first_name: "first",
      last_name: "last",
      location: [47.67557, -122.26557],
      destination: [47.67357, -122.26557],
      color: "E14726",
      icon: new LeafIcon({
        iconUrl:
          "https://chart.apis.google.com/chart?chst=d_map_pin_icon&chld=car|E14726",
      }),
    },
  ];
