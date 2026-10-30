#!/bin/bash
# Uso: echo VALOR | bash set-env-var.sh NOMBRE LARGO_MINIMO
# Cambia NOMBRE=... en /etc/zscore-license.env (con copia de respaldo). No imprime el valor.
f=/etc/zscore-license.env
name="$1"; min="$2"
read -r v
v=$(printf '%s' "$v" | tr -d '\r\n \t')
echo "$name: largo recibido = ${#v}"
if [ "${#v}" -lt "$min" ]; then echo "Demasiado corto (minimo $min): no se cambia nada."; exit 1; fi
cp -p "$f" "$f.bak-$(date +%s)"
if grep -q "^$name=" "$f"; then
  sed -i "s|^$name=.*|$name=$v|" "$f"
else
  printf '%s=%s\n' "$name" "$v" >> "$f"
fi
echo "$name actualizado"
