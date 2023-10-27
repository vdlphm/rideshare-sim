from django.urls import path, include

from rider.services import rider_service

urlpatterns = [
    path('register/', rider_service.registerRider)
]
