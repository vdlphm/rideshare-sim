def decode_polyline(polyline, is3d=False):
    """Decodes a Polyline string into a GeoJSON geometry.
    :param polyline: An encoded polyline, only the geometry.
    :type polyline: string
    :param is3d: Specifies if geometry contains Z component.
    :type is3d: boolean
    :returns: GeoJSON Linestring geometry
    :rtype: dict
    """
    points = []
    index = lat = lng = z = 0

    while index < len(polyline):
        result = 1
        shift = 0
        while True:
            b = ord(polyline[index]) - 63 - 1
            index += 1
            result += b << shift
            shift += 5
            if b < 0x1F:
                break
        lat += (~result >> 1) if (result & 1) != 0 else (result >> 1)

        result = 1
        shift = 0
        while True:
            b = ord(polyline[index]) - 63 - 1
            index += 1
            result += b << shift
            shift += 5
            if b < 0x1F:
                break
        lng += ~(result >> 1) if (result & 1) != 0 else (result >> 1)

        if is3d:
            result = 1
            shift = 0
            while True:
                b = ord(polyline[index]) - 63 - 1
                index += 1
                result += b << shift
                shift += 5
                if b < 0x1F:
                    break
            if (result & 1) != 0:
                z += ~(result >> 1)
            else:
                z += result >> 1

            points.append(
                [
                    round(lng * 1e-5, 6),
                    round(lat * 1e-5, 6),
                    round(z * 1e-2, 1),
                ]
            )

        else:
            points.append([round(lng * 1e-5, 6), round(lat * 1e-5, 6)])

    geojson = {u"type": u"LineString", u"coordinates": points}

    return geojson


print(decode_polyline("yf~aHx~fiVA`@Ud@S[C_@iBsCyBmDWIQW^aA?aHV?"))