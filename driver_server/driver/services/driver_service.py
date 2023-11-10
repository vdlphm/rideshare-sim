from django.contrib.auth.hashers import make_password
from django.core.exceptions import ValidationError
from django.db import IntegrityError
from rest_framework.decorators import api_view
from django.http import JsonResponse

from driver.models import Driver


@api_view(['POST'])
def registerRider(req):
    try:
        rider = Driver(
            email=req.data['email'],
            first_name=req.data['firstname'],
            last_name=req.data['lastname'],
            password=make_password(req.data['password'])
        )
        # validate data before save
        rider.full_clean()
        rider.save()
        return JsonResponse(status=201, data={'id': rider.id})
    except IntegrityError as err:
        return JsonResponse(status=400, data={
            'errors': [m for m in err.args],
            'fields': ['email']
        })
    except ValidationError as err:
        return JsonResponse(status=400, data={
            'errors': [f'{field} cannot be blank' for field in err.message_dict],
            'fields': [field for field in err.message_dict]
        })
    except Exception as ex:
        return JsonResponse(status=500, data={
            'errors': ['Server error please try again']
        })
