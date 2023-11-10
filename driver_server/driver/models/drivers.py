import uuid

from django.contrib.auth.models import AbstractUser
from django.core.validators import MinLengthValidator
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from driver.models.managers import DriverManager


class Driver(AbstractUser):
    class Meta:
        verbose_name = _("driver")
        verbose_name_plural = _("driver")

    id = models.UUIDField(_("Driver ID"), primary_key=True, default=uuid.uuid4)

    # Login info
    email = models.EmailField(_("Driver email address"), unique=True, max_length=320, validators=[MinLengthValidator(1)])
    password = models.CharField(_("password"), max_length=128, validators=[MinLengthValidator(1)])

    # Basic info
    username = None
    first_name = models.CharField(_("Driver first name"), max_length=50, validators=[MinLengthValidator(1)])
    last_name = models.CharField(_("Driver last name"), max_length=50, validators=[MinLengthValidator(1)])

    # Date
    date_joined = models.DateTimeField(default=timezone.now)

    objects = DriverManager()

    USERNAME_FIELD = "email"
    REQUIRED_FIELDS = ["first_name", "last_name"]

    def __str__(self):
        return self.email
