import requests
from django.http import JsonResponse
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
import environ

env = environ.Env()
environ.Env.read_env()

ORS_PATH = f'http://{env("ORS_HOST")}:{env("ORS_PORT")}/{env("ORS_GET_DIR")}'


def getDirection(coordinates):
    # TODO: add cache
    res = requests.post(ORS_PATH, json=coordinates)
    if not res.ok:
        raise Exception('ORS service error')
    else:
        return res


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def getNewRideInfo(req):
    try:
        res = getDirection(req.data).json()['routes'][0]
        return JsonResponse(status=200, data={
            'summary': res['summary'],
            'geometry': res['geometry']
        })
    except Exception as err:
        return JsonResponse(status=500, data={'errors': ['ORS service error']})
