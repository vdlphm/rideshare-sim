from django.urls import path
from .services import driver_service

urlpatterns = [
    path('register/', driver_service.registerRider)
]
