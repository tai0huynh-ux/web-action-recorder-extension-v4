CC ?= cc
CFLAGS ?= -O2 -Wall -Wextra -pedantic
LDFLAGS ?=
LIBS := -lX11 -lXtst

all: war-x11-inputd

war-x11-inputd: x11-inputd.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS) $(LIBS)

clean:
	rm -f war-x11-inputd
